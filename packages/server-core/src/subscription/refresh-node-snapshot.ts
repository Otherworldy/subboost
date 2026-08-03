import { parseSubscription } from "@subboost/core/parser";
import { stripImportedNodeControlFields } from "@subboost/core/subscription/imported-node-controls";
import {
  keepOnlyValidNodeSourceIds,
  normalizeNodeOriginName,
} from "@subboost/core/subscription/node-source-state";
import {
  detachSourceNodesFromState,
  type DeletedNodeDescriptor,
  mergeParsedSourceNodes,
  prepareSourceParsedNodes,
} from "@subboost/core/subscription/source-node-refresh";
import {
  applyNodeHealthResults,
  getNodeHealthResults,
  resolveSourceHealthCheck,
  stripNodeHealthResultsForSource,
  withoutNodeHealthResultsForSources,
  type NodeHealthResult,
} from "@subboost/core/subscription/node-health";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import {
  hasSubscriptionUserInfo,
  mergeSubscriptionUserInfo,
  normalizeSubscriptionUserInfo,
  parseSubscriptionUserInfo,
  resolveSubscriptionUserInfo,
  type SubscriptionUserInfo,
} from "@subboost/core/subscription/subscription-userinfo";
import {
  pickSubscriptionResponseInfoFromHeaders,
  type SubscriptionResponseInfo,
} from "@subboost/core/subscription/subscription-response-info";
import type { SubscriptionImportErrorCategory } from "@subboost/core/subscription/import-error";
import type { ParsedNode } from "@subboost/core/types/node";
import { normalizeSavedSourcesForPersistence, type SavedSource, type SavedSourceType } from "./saved-sources";

type UrlNodeFetchResult = {
  ok: boolean;
  nodes: ParsedNode[];
  errors?: string[];
  headers?: Record<string, string>;
  error?: string;
  errorInfo?: {
    category?: SubscriptionImportErrorCategory;
    message?: string;
    detail?: string;
    httpStatus?: number;
  } | null;
  publicReason?: string | null;
  responseStatus?: number;
};

export type RefreshNodeSnapshotFailedSource = {
  id: string;
  type: SavedSourceType;
  content: string;
  errorMessage: string;
  errorCategory?: SubscriptionImportErrorCategory;
  httpStatus?: number;
  publicReason?: string | null;
};

export type RefreshNodeSnapshotOptions = {
  config: Record<string, unknown>;
  urls: string[];
  storedNodes: ParsedNode[];
  fetchUrlNodes: (source: SavedSource) => Promise<UrlNodeFetchResult>;
  fetchUrlUserInfo?: (source: SavedSource) => Promise<Record<string, string> | undefined>;
  // 自动测活：返回按节点名（订阅状态内唯一）的测活结果；未提供或源未开启时跳过。
  // onResult 在单个节点出结果时回调（用于流式进度）；onHealthProgress 汇总 tested/total。
  runHealthCheck?: (params: {
    source: SavedSource;
    nodes: ParsedNode[];
    onResult?: (nodeName: string, result: NodeHealthResult) => void;
  }) => Promise<Map<string, NodeHealthResult>>;
  onHealthProgress?: (tested: number, total: number) => void;
};

export type RefreshNodeSnapshotResult = {
  nodes: ParsedNode[];
  subscriptionInfo: SubscriptionResponseInfo;
  savedSources: SavedSource[];
  attemptedUrlFetch: boolean;
  usedUrlFetch: boolean;
  refreshableSourceCount: number;
  refreshedSourceCount: number;
  refreshedUrlSourceCount: number;
  refreshedStaticSourceCount: number;
  detachedSourceCount: number;
  failedSourceCount: number;
  failedSources: RefreshNodeSnapshotFailedSource[];
};

function getDeletedNodeNames(config: Record<string, unknown>): string[] {
  if (!Array.isArray(config.deletedNodeNames)) return [];
  return (config.deletedNodeNames as unknown[])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getDeletedNodes(config: Record<string, unknown>): DeletedNodeDescriptor[] {
  if (!Array.isArray(config.deletedNodes)) return [];
  return (config.deletedNodes as unknown[]).filter(
    (item): item is DeletedNodeDescriptor => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

export function resolveSmartNodeMatchingEnabled(config: Record<string, unknown>): boolean {
  return config.smartNodeMatchingEnabled !== false;
}

type StableMetadataState = {
  value?: string;
  conflicted: boolean;
};

function mergeStableMetadataValue(state: StableMetadataState, nextValue: string | undefined) {
  if (!nextValue || state.conflicted) return;
  if (!state.value) {
    state.value = nextValue;
    return;
  }
  if (state.value !== nextValue) {
    state.value = undefined;
    state.conflicted = true;
  }
}

export async function refreshNodeSnapshot(
  options: RefreshNodeSnapshotOptions
): Promise<RefreshNodeSnapshotResult> {
  const savedSources = normalizeSavedSourcesForPersistence(options.config.sources, {
    fallbackUrls: options.urls,
  });
  let refreshedSavedSources = savedSources.map((source) => ({ ...source }));
  const validSourceIds = new Set(savedSources.map((source) => source.id));
  const deletedNodeNames = getDeletedNodeNames(options.config);
  const deletedNodes = getDeletedNodes(options.config);
  const smartNodeMatchingEnabled = resolveSmartNodeMatchingEnabled(options.config);

  let currentNodes = options.storedNodes
    .map(stripImportedNodeControlFields)
    .map(normalizeNodeOriginName)
    .map((node) => keepOnlyValidNodeSourceIds(node, validSourceIds))
    .filter(Boolean) as ParsedNode[];
  // 来源已从配置中删除时，一并清掉其残留测活结果
  currentNodes = currentNodes.map((node) => {
    const staleIds = Object.keys(getNodeHealthResults(node)).filter((id) => !validSourceIds.has(id));
    return staleIds.length > 0 ? withoutNodeHealthResultsForSources(node, staleIds) : node;
  });

  const subscriptionInfo: SubscriptionResponseInfo = {};
  const profileWebPageUrlState: StableMetadataState = { conflicted: false };
  const planNameState: StableMetadataState = { conflicted: false };
  const attemptedUrlFetch = savedSources.some((source) => source.type === "url" && !source.useProxyProviders);
  let usedUrlFetch = false;
  let refreshableSourceCount = 0;
  let refreshedSourceCount = 0;
  let refreshedUrlSourceCount = 0;
  let refreshedStaticSourceCount = 0;
  let detachedSourceCount = 0;
  let failedSourceCount = 0;
  const failedSources: RefreshNodeSnapshotFailedSource[] = [];

  const recordFailedSource = (
    source: SavedSource,
    errorMessage: string,
    extra: {
      errorCategory?: SubscriptionImportErrorCategory;
      httpStatus?: number;
      publicReason?: string | null;
    } = {}
  ) => {
    failedSourceCount += 1;
    failedSources.push({
      id: source.id,
      type: source.type,
      content: source.content,
      errorMessage,
      ...extra,
    });
  };

  // 对开启自动测活的源执行测活并把结果按来源写回节点；节点内容在合并时已刷新，
  // 内容变化的节点不带旧结果，因此不存在过期结果残留。
  // 进度口径：total 随已开始的源累计（刷新过程中才知道各源节点数），tested 单调递增。
  let healthTested = 0;
  let healthTotal = 0;
  const runSourceHealthCheck = async (source: SavedSource) => {
    if (!resolveSourceHealthCheck(source).enabled) return;
    if (typeof options.runHealthCheck !== "function") return;
    const sourceNodes = currentNodes.filter((node) => getNodeSourceIds(node).includes(source.id));
    if (sourceNodes.length === 0) return;
    healthTotal += sourceNodes.length;
    options.onHealthProgress?.(healthTested, healthTotal);
    const results = await options.runHealthCheck({
      source,
      nodes: sourceNodes,
      onResult: () => {
        healthTested += 1;
        options.onHealthProgress?.(healthTested, healthTotal);
      },
    });
    currentNodes = applyNodeHealthResults(currentNodes, source.id, results);
  };

  const mergeResponseMetadata = (headers?: Record<string, string>) => {
    const responseInfo = pickSubscriptionResponseInfoFromHeaders(headers);
    mergeStableMetadataValue(profileWebPageUrlState, responseInfo.profileWebPageUrl);
    mergeStableMetadataValue(planNameState, responseInfo.planName);
  };

  const updateSourceSubscriptionInfo = (sourceId: string, info: SubscriptionUserInfo | undefined) => {
    const index = refreshedSavedSources.findIndex((source) => source.id === sourceId);
    if (index < 0) return;

    const normalized = normalizeSubscriptionUserInfo(info);
    if (hasSubscriptionUserInfo(normalized)) {
      refreshedSavedSources = refreshedSavedSources.map((source, i) =>
        i === index ? { ...source, subscriptionUserInfo: normalized } : source
      );
      return;
    }

    refreshedSavedSources = refreshedSavedSources.map((source, i) => {
      if (i !== index) return source;
      const next = { ...source };
      delete next.subscriptionUserInfo;
      return next;
    });
  };

  const mergeSourceSubscriptionInfo = (sourceId: string, info: SubscriptionUserInfo | undefined) => {
    updateSourceSubscriptionInfo(sourceId, info);
    const normalized = normalizeSubscriptionUserInfo(info);
    if (hasSubscriptionUserInfo(normalized)) {
      mergeSubscriptionUserInfo(subscriptionInfo, normalized);
    }
  };

  const shouldFetchSupplementalUserInfoForSource = (source: SavedSource): boolean => {
    return Boolean(source.userinfoUrl || source.userinfoUserAgent);
  };

  for (const source of savedSources) {
    if (source.type === "url" && source.useProxyProviders) {
      const detached = detachSourceNodesFromState(currentNodes, source.id);
      if (detached.nodes.length !== currentNodes.length) {
        detachedSourceCount += 1;
        refreshedSourceCount += 1;
      }
      currentNodes = detached.nodes;
      // proxy-providers 模式不保留该来源的测活设置与结果
      currentNodes = stripNodeHealthResultsForSource(currentNodes, source.id);
      if (
        typeof options.fetchUrlUserInfo === "function" &&
        shouldFetchSupplementalUserInfoForSource(source)
      ) {
        const headers = await options.fetchUrlUserInfo(source);
        if (headers) {
          mergeResponseMetadata(headers);
          const header = headers["subscription-userinfo"];
          mergeSourceSubscriptionInfo(
            source.id,
            header ? resolveSubscriptionUserInfo(parseSubscriptionUserInfo(header)) : undefined
          );
        }
      }
      continue;
    }

    refreshableSourceCount += 1;

    if (source.type === "url") {
      const fetched = await options.fetchUrlNodes(source);
      mergeResponseMetadata(fetched.headers);
      const userInfoHeader = fetched.headers?.["subscription-userinfo"];
      const rawUserInfo = userInfoHeader ? parseSubscriptionUserInfo(userInfoHeader) : undefined;
      const resolvedUserInfo = resolveSubscriptionUserInfo(
        rawUserInfo,
        fetched.ok ? fetched.nodes : []
      );
      if (hasSubscriptionUserInfo(resolvedUserInfo)) {
        mergeSubscriptionUserInfo(subscriptionInfo, resolvedUserInfo);
      }

      if (!fetched.ok || fetched.nodes.length === 0) {
        const errorInfo = fetched.errorInfo ?? null;
        const firstParseError =
          Array.isArray(fetched.errors) && typeof fetched.errors[0] === "string"
            ? fetched.errors[0]
            : null;
        const errorMessage =
          errorInfo?.detail ||
          errorInfo?.message ||
          fetched.error ||
          firstParseError ||
          "未解析到可用节点";
        recordFailedSource(source, errorMessage, {
          errorCategory: errorInfo?.category ?? (firstParseError ? "parse" : undefined),
          httpStatus: errorInfo?.httpStatus ?? fetched.responseStatus,
          publicReason: fetched.publicReason ?? null,
        });
        continue;
      }
      updateSourceSubscriptionInfo(source.id, resolvedUserInfo);

      const parsedNodes = prepareSourceParsedNodes(fetched.nodes, {
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
      });
      const merged = mergeParsedSourceNodes(currentNodes, parsedNodes, deletedNodeNames, {
        sourceId: source.id,
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
        lastTag: source.lastParsedTag,
        lastNameTemplate: source.lastParsedNameTemplate,
        treatAsNewSource: Boolean(
          source.lastParsedContent &&
            source.lastParsedContent.trim() &&
            source.lastParsedContent.trim() !== source.content.trim()
        ),
        smartNodeMatchingEnabled,
        deletedNodes,
      });

      currentNodes = merged.nodes;
      usedUrlFetch = true;
      refreshedSourceCount += 1;
      refreshedUrlSourceCount += 1;
      await runSourceHealthCheck(source);
      continue;
    }

    try {
      const parsed = parseSubscription(source.content);
      const resolvedUserInfo = resolveSubscriptionUserInfo(undefined, parsed.nodes);
      if (hasSubscriptionUserInfo(resolvedUserInfo)) {
        mergeSubscriptionUserInfo(subscriptionInfo, resolvedUserInfo);
      }
      if (parsed.nodes.length === 0) {
        recordFailedSource(source, "未解析到可用节点", { errorCategory: "parse" });
        continue;
      }
      updateSourceSubscriptionInfo(source.id, resolvedUserInfo);

      const parsedNodes = prepareSourceParsedNodes(parsed.nodes, {
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
      });
      const merged = mergeParsedSourceNodes(currentNodes, parsedNodes, deletedNodeNames, {
        sourceId: source.id,
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
        lastTag: source.lastParsedTag,
        lastNameTemplate: source.lastParsedNameTemplate,
        treatAsNewSource: false,
        smartNodeMatchingEnabled,
        deletedNodes,
      });

      currentNodes = merged.nodes;
      refreshedSourceCount += 1;
      refreshedStaticSourceCount += 1;
      await runSourceHealthCheck(source);
    } catch (error) {
      recordFailedSource(source, error instanceof Error ? error.message : "解析失败", {
        errorCategory: "parse",
      });
    }
  }

  if (
    typeof options.fetchUrlUserInfo === "function" &&
    usedUrlFetch &&
    (
      !hasSubscriptionUserInfo(subscriptionInfo) ||
      savedSources.some((source) => source.type === "url" && shouldFetchSupplementalUserInfoForSource(source))
    )
  ) {
    for (const source of savedSources) {
      if (source.type !== "url" || source.useProxyProviders) continue;
      if (!shouldFetchSupplementalUserInfoForSource(source) && hasSubscriptionUserInfo(subscriptionInfo)) continue;
      const headers = await options.fetchUrlUserInfo(source);
      if (!headers) continue;
      mergeResponseMetadata(headers);
      const header = headers["subscription-userinfo"];
      mergeSourceSubscriptionInfo(
        source.id,
        header ? resolveSubscriptionUserInfo(parseSubscriptionUserInfo(header)) : undefined
      );
    }
  }

  if (!profileWebPageUrlState.conflicted && profileWebPageUrlState.value) {
    subscriptionInfo.profileWebPageUrl = profileWebPageUrlState.value;
  }
  if (!planNameState.conflicted && planNameState.value) {
    subscriptionInfo.planName = planNameState.value;
  }

  return {
    nodes: currentNodes,
    subscriptionInfo,
    savedSources: refreshedSavedSources,
    attemptedUrlFetch,
    usedUrlFetch,
    refreshableSourceCount,
    refreshedSourceCount,
    refreshedUrlSourceCount,
    refreshedStaticSourceCount,
    detachedSourceCount,
    failedSourceCount,
    failedSources,
  };
}
