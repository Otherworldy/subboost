import { randomBytes, randomUUID } from "node:crypto";
import { buildNodeContentKey } from "@subboost/core/node-identity";
import { generateClashYaml } from "@subboost/core/generator";
import { buildGenerateOptionsFromConfig, getEffectiveTestOptions } from "@subboost/core/subscription/config-utils";
import { buildProxyProvidersFromConfig } from "@subboost/core/subscription/proxy-providers";
import {
  applyNodeHealthResults,
  filterNodesByHealth,
  getHealthCheckCacheConfigKey,
  getNodeHealthResults,
  getNodeHealthSourceDescriptors,
  HEALTH_RESULTS_KEY,
  resolveSourceHealthCheck,
  summarizeNodeHealth,
  withoutNodeHealthResultsForSources,
  type NodeHealthResult,
} from "@subboost/core/subscription/node-health";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import type { SubscriptionResponseInfo } from "@subboost/core/subscription/subscription-response-info";
import type { ParsedNode } from "@subboost/core/types/node";
import {
  buildManualRefreshFailureResponse,
  buildManualRefreshSuccessResponseBody,
  normalizeSubscriptionConfigForPersistence,
  normalizeSubscriptionInfoForPersistence,
  normalizeSubscriptionName,
  normalizeSubscriptionUrlList,
  prepareRefreshCacheResult,
  refreshNodeSnapshot,
  serializeSubscriptionDetailData,
  serializeSubscriptionSummaryData,
  validateSubscriptionNodeList,
  type SavedSource,
  type RefreshNodeSnapshotResult,
} from "@subboost/server-core/subscription";
import { decryptJson, decryptJsonObject, encryptJson } from "./crypto";
import { getAppUrl } from "./env";
import { prisma } from "./prisma";
import { fetchSourceUserInfoHeadersDirect, importSourceUrlDirect } from "./source-import";
import { runMihomoHealthCheck } from "./mihomo-health-check";
import { normalizeLocalAutoUpdateIntervalSeconds } from "./auto-update-policy";

export const MAX_NODES_PER_SUBSCRIPTION = 10000;
export const CACHE_TTL_SECONDS = 3600;

export const SUBSCRIPTION_BACKUP_TYPE = "subboost-subscriptions";
export const SUBSCRIPTION_BACKUP_VERSION = 1;

export type SubscriptionRow = {
  id: string;
  ownerId: string;
  name: string;
  token: string;
  isPrimary: boolean;
  encryptedUrls: string;
  encryptedNodes: string;
  encryptedConfig: string;
  encryptedSubscriptionInfo: string | null;
  autoUpdateInterval: number | null;
  cacheExpiresAt: Date | null;
  lastAccessedAt: Date | null;
  lastUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  autoUpdateState?: {
    externalFailureCount: number;
    failureSourceState: string | null;
    lastFailedAt: Date | null;
    lastAttemptedAt: Date | null;
    disabledAt: Date | null;
    disabledReason: string | null;
    disabledPreviousInterval: number | null;
  } | null;
};

export type SubscriptionSummary = {
  id: string;
  name: string;
  token: string;
  subscriptionUrl: string;
  nodeCount: number;
  sourceCount: number;
  yamlUrl: string;
  isPrimary: boolean;
  autoUpdateInterval: number | null;
  smartNodeMatchingEnabled: boolean;
  cacheExpiresAt: string | null;
  lastAccessedAt: string | null;
  lastUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  autoUpdateState: {
    externalFailureCount: number;
    lastFailedAt: string | null;
    lastAttemptedAt: string | null;
    disabledAt: string | null;
    disabledReason: string | null;
    disabledPreviousInterval: number | null;
  };
};

export type SubscriptionDetail = SubscriptionSummary & {
  urls: string[];
  nodes: ParsedNode[];
  config: Record<string, unknown>;
  subscriptionInfo: Record<string, unknown>;
};

export type GeneratedSubscriptionYaml = {
  yaml: string;
  name: string;
  subscriptionInfo: SubscriptionResponseInfo;
  cacheExpirySeconds: number;
  autoUpdateIntervalSeconds: number | null;
  isAdmin: boolean;
  // 原始节点存在但自动测活/用户过滤后没有可用节点（下载端返回明确提示）
  isEmpty?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateLocalSubscriptionNodes(value: unknown): ParsedNode[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.length > MAX_NODES_PER_SUBSCRIPTION) {
    throw new Error(`Node count cannot exceed ${MAX_NODES_PER_SUBSCRIPTION}.`);
  }
  return validateSubscriptionNodeList(value);
}

function buildLocalSubscriptionUrl(token: string): string {
  return `${getAppUrl()}/api/subscriptions/${token}/config.yaml`;
}

function buildLocalSubscriptionConfig(
  body: Record<string, unknown>,
  existingConfig: Record<string, unknown> = {}
): Record<string, unknown> {
  return normalizeSubscriptionConfigForPersistence(
    {
      config: body.config,
      smartNodeMatchingEnabled: body.smartNodeMatchingEnabled,
    },
    {
      existingConfig,
      idFactory: randomUUID,
      splitUrlLines: true,
      mergeExistingConfig: false,
      defaultSmartNodeMatchingEnabled: true,
    }
  );
}

function stripHealthResultsForChangedSources(
  nodes: ParsedNode[],
  previousConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>
): ParsedNode[] {
  const previous = new Map(getNodeHealthSourceDescriptors(previousConfig).map((source) => [source.id, source]));
  const next = new Map(getNodeHealthSourceDescriptors(nextConfig).map((source) => [source.id, source]));
  const changed = new Set<string>();
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const previousSource = previous.get(id);
    const nextSource = next.get(id);
    if (
      !previousSource ||
      !nextSource ||
      getHealthCheckCacheConfigKey(previousSource) !== getHealthCheckCacheConfigKey(nextSource)
    ) {
      changed.add(id);
    }
  }
  if (changed.size === 0) return nodes;
  return nodes.map((node) => withoutNodeHealthResultsForSources(node, changed));
}

function stripHealthResultsForChangedNodes(nodes: ParsedNode[], previousNodes: ParsedNode[]): ParsedNode[] {
  const previousByName = new Map(previousNodes.map((node) => [node.name, node]));
  return nodes.map((node) => {
    const previous = previousByName.get(node.name);
    if (previous && buildNodeContentKey(previous) === buildNodeContentKey(node)) return node;
    return withoutNodeHealthResultsForSources(node, getNodeSourceIds(node));
  });
}

function assertNodeNameFilterKeepsOutput(
  nodes: ParsedNode[],
  config: Record<string, unknown>
): void {
  if (nodes.length === 0) return;
  const options = buildGenerateOptionsFromConfig(config, { nodes });
  const hasProxyProviders = Boolean(
    options.proxyProviders && Object.keys(options.proxyProviders).length > 0
  );
  if (options.nodes.length === 0 && !hasProxyProviders) {
    // 自动测活把所有节点判为失败是合法状态（保存后页面可见、下载提示无节点）；
    // 只有用户名称过滤把健康节点全部排除时才视为配置错误。
    const healthFiltered = filterNodesByHealth(nodes, config);
    if (healthFiltered.length > 0) {
      throw new Error("过滤后没有可用节点");
    }
  }
}

export function generateLocalSubscriptionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 可选的自定义订阅链接标识：留空返回 ""（调用方随机生成）。 */
export function normalizeLocalSubscriptionToken(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("订阅链接标识必须是字符串");
  const token = value.trim();
  if (!token) return "";
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(token)) {
    throw new Error("订阅链接标识仅支持 4-64 位字母、数字、下划线或短横线");
  }
  return token;
}

export function readSubscriptionSecrets(row: SubscriptionRow) {
  return {
    urls: decryptJson<string[]>(row.encryptedUrls, []),
    nodes: decryptJson<ParsedNode[]>(row.encryptedNodes, []),
    config: decryptJsonObject(row.encryptedConfig),
    subscriptionInfo:
      normalizeSubscriptionInfoForPersistence(decryptJson<unknown>(row.encryptedSubscriptionInfo, {})) ?? {},
  };
}

export function formatSubscription(row: SubscriptionRow): SubscriptionSummary {
  const secrets = readSubscriptionSecrets(row);
  const subscriptionUrl = buildLocalSubscriptionUrl(row.token);
  return serializeSubscriptionSummaryData(row, secrets, {
    subscriptionUrl,
    yamlUrl: subscriptionUrl,
    dateMode: "iso",
    includeCounts: true,
    includeFailureSourceState: false,
    includeLastAttemptedAt: true,
  }) as SubscriptionSummary;
}

export function formatSubscriptionDetail(row: SubscriptionRow): SubscriptionDetail {
  const secrets = readSubscriptionSecrets(row);
  const subscriptionUrl = buildLocalSubscriptionUrl(row.token);
  return serializeSubscriptionDetailData(row, secrets, {
    subscriptionUrl,
    yamlUrl: subscriptionUrl,
    dateMode: "iso",
    includeCounts: true,
    includeFailureSourceState: false,
    includeLastAttemptedAt: true,
  }) as SubscriptionDetail;
}

export async function listSubscriptions(ownerId: string): Promise<SubscriptionSummary[]> {
  const rows = await prisma.subscription.findMany({
    where: { ownerId },
    include: { autoUpdateState: true },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(formatSubscription);
}

export async function createSubscription(
  ownerId: string,
  body: unknown,
  onProgress?: (tested: number, total: number) => void
): Promise<{ subscription: SubscriptionSummary; nodes: ParsedNode[] }> {
  if (!isRecord(body)) {
    throw new Error("Invalid request body.");
  }
  const name = normalizeSubscriptionName(body.name);
  if (!name) throw new Error("Subscription name is required.");

  const urls = normalizeSubscriptionUrlList(body.urls);
  const nodes = validateLocalSubscriptionNodes(body.nodes);
  if (urls.length === 0 && nodes.length === 0) throw new Error("At least one URL or node is required.");

  const config = buildLocalSubscriptionConfig(body);
  // 开启自动测活的源：保存前立即测活，结果随节点一起持久化；内核系统性失败则不创建
  const nodesWithHealth = await runSubscriptionHealthChecks(
    nodes,
    (config.sources ?? []) as SavedSource[],
    onProgress
  );
  assertNodeNameFilterKeepsOutput(nodesWithHealth, config);
  const autoUpdateInterval = normalizeLocalAutoUpdateIntervalSeconds(body.autoUpdateInterval);
  const subscriptionInfo = normalizeSubscriptionInfoForPersistence(body.subscriptionInfo) ?? {};

  const subscriptionToken = normalizeLocalSubscriptionToken(body.token);
  let row: SubscriptionRow;
  try {
    row = await prisma.subscription.create({
      data: {
        ownerId,
        name,
        token: subscriptionToken || generateLocalSubscriptionToken(),
        encryptedUrls: encryptJson(urls),
        encryptedNodes: encryptJson(nodesWithHealth),
        encryptedConfig: encryptJson(config),
        encryptedSubscriptionInfo: encryptJson(subscriptionInfo),
        autoUpdateInterval,
      },
      include: { autoUpdateState: true },
    });
  } catch (error) {
    if (isSubscriptionTokenConflictError(error)) {
      throw new Error("该订阅链接标识已被使用，请更换后重试");
    }
    throw error;
  }
  return { subscription: formatSubscription(row), nodes: nodesWithHealth };
}

function isSubscriptionTokenConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || (error as { code?: unknown }).code !== "P2002") {
    return false;
  }
  const meta = (error as { meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } } }).meta;
  const target = meta?.target;
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  return (
    (Array.isArray(target) && target.includes("token")) ||
    (Array.isArray(fields) && fields.includes("token"))
  );
}

function stripSourceParseCaches(config: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(config.sources)) return config;
  return {
    ...config,
    sources: (config.sources as Record<string, unknown>[]).map((source) => {
      const { lastParsedContent, lastParsedTag, lastParsedNameTemplate, ...rest } = source;
      return rest;
    }),
  };
}

export type SubscriptionBackup = {
  type: typeof SUBSCRIPTION_BACKUP_TYPE;
  version: typeof SUBSCRIPTION_BACKUP_VERSION;
  exportedAt: string;
  subscriptions: Array<{
    name: string;
    token: string;
    urls: string[];
    config: Record<string, unknown>;
    subscriptionInfo: Record<string, unknown>;
    autoUpdateInterval: number | null;
  }>;
};

export async function exportSubscriptions(ownerId: string, ids?: string[]): Promise<SubscriptionBackup> {
  const rows = await prisma.subscription.findMany({
    where: {
      ownerId,
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  return {
    type: SUBSCRIPTION_BACKUP_TYPE,
    version: SUBSCRIPTION_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    subscriptions: rows.map((row) => {
      const secrets = readSubscriptionSecrets(row);
      return {
        name: row.name,
        token: row.token,
        urls: secrets.urls,
        config: stripSourceParseCaches(secrets.config),
        subscriptionInfo: secrets.subscriptionInfo,
        autoUpdateInterval: row.autoUpdateInterval,
      };
    }),
  };
}

export async function importSubscriptions(
  ownerId: string,
  payload: unknown
): Promise<{
  imported: string[];
  failed: Array<{ name: string; reason: string }>;
  warnings: Array<{ name: string; reason: string }>;
}> {
  const rawItems = isRecord(payload) && Array.isArray(payload.subscriptions) ? payload.subscriptions : payload;
  if (!Array.isArray(rawItems)) {
    throw new Error("备份文件格式无效：缺少订阅列表");
  }

  const imported: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const warnings: Array<{ name: string; reason: string }> = [];
  for (const item of rawItems) {
    const name = isRecord(item) ? normalizeSubscriptionName(item.name) : "";
    if (!name) {
      failed.push({ name: "未命名订阅", reason: "订阅名称无效" });
      continue;
    }
    try {
      const token = normalizeLocalSubscriptionToken(item.token);
      if (!token) throw new Error("订阅链接标识无效");
      const urls = normalizeSubscriptionUrlList(item.urls);
      const config = normalizeSubscriptionConfigForPersistence(
        { config: item.config },
        { mergeExistingConfig: false, defaultSmartNodeMatchingEnabled: true }
      );
      const hasSources = Array.isArray(config.sources) && config.sources.length > 0;
      if (urls.length === 0 && !hasSources) throw new Error("没有订阅源");
      const subscriptionInfo = normalizeSubscriptionInfoForPersistence(item.subscriptionInfo) ?? {};
      const autoUpdateInterval = normalizeLocalAutoUpdateIntervalSeconds(item.autoUpdateInterval);
      let row: SubscriptionRow;
      try {
        row = await prisma.subscription.create({
          data: {
            ownerId,
            name,
            token,
            encryptedUrls: encryptJson(urls),
            encryptedNodes: encryptJson([]),
            encryptedConfig: encryptJson(config),
            encryptedSubscriptionInfo: encryptJson(subscriptionInfo),
            autoUpdateInterval,
          },
          include: { autoUpdateState: true },
        });
      } catch (error) {
        if (isSubscriptionTokenConflictError(error)) {
          throw new Error("链接标识已被使用");
        }
        throw error;
      }
      // 导入后自动通过订阅源拉取/解析恢复节点（不测活），失败不阻塞导入
      try {
        const snapshot = await refreshNodeSnapshot({
          config,
          urls,
          storedNodes: [],
          ...buildSubscriptionFetchCallbacks(),
          runHealthCheck: undefined,
        });
        await prisma.subscription.update({
          where: { id: row.id },
          data: {
            encryptedNodes: encryptJson(snapshot.nodes),
            encryptedConfig: encryptJson({ ...config, sources: snapshot.savedSources }),
            encryptedSubscriptionInfo: encryptJson(snapshot.subscriptionInfo),
          },
        });
        if (snapshot.failedSources.length > 0) {
          warnings.push({ name, reason: `${snapshot.failedSources.length} 个订阅源获取失败` });
        }
      } catch (error) {
        warnings.push({
          name,
          reason: error instanceof Error ? `节点获取失败：${error.message}` : "节点获取失败",
        });
      }
      imported.push(name);
    } catch (error) {
      failed.push({ name, reason: error instanceof Error ? error.message : "导入失败" });
    }
  }
  return { imported, failed, warnings };
}

export async function updateSubscription(
  ownerId: string,
  id: string,
  body: unknown,
  onProgress?: (tested: number, total: number) => void
): Promise<{ subscription: SubscriptionSummary | null; nodes: ParsedNode[] }> {
  if (!isRecord(body)) throw new Error("Invalid request body.");
  const current = await prisma.subscription.findFirst({ where: { id, ownerId }, include: { autoUpdateState: true } });
  if (!current) return { subscription: null, nodes: [] };

  const currentSecrets = readSubscriptionSecrets(current);
  const name = normalizeSubscriptionName(body.name) || current.name;
  const data: Record<string, unknown> = { name };
  const hasUrls = "urls" in body;
  const hasNodes = "nodes" in body;
  const hasConfig = "config" in body || "smartNodeMatchingEnabled" in body;
  const nextNodes = hasNodes ? validateLocalSubscriptionNodes(body.nodes) : currentSecrets.nodes;
  let nextConfig = currentSecrets.config;

  if (hasUrls) {
    data.encryptedUrls = encryptJson(normalizeSubscriptionUrlList(body.urls));
  }
  if (hasNodes) {
    data.encryptedNodes = encryptJson(nextNodes);
  }
  if (hasConfig) {
    nextConfig = buildLocalSubscriptionConfig(body, currentSecrets.config);
    data.encryptedConfig = encryptJson(nextConfig);
  }
  if ("subscriptionInfo" in body) {
    data.encryptedSubscriptionInfo = encryptJson(normalizeSubscriptionInfoForPersistence(body.subscriptionInfo) ?? {});
  }

  let nodesWithHealth = hasNodes
    ? stripHealthResultsForChangedNodes(nextNodes, currentSecrets.nodes)
    : nextNodes;
  if (hasConfig) {
    nodesWithHealth = stripHealthResultsForChangedSources(nodesWithHealth, currentSecrets.config, nextConfig);
  }
  if (hasUrls || hasNodes || hasConfig) {
    const nextUrls = hasUrls ? normalizeSubscriptionUrlList(body.urls) : currentSecrets.urls;
    if (nextUrls.length === 0 && nextNodes.length === 0) {
      throw new Error("At least one URL or node is required.");
    }
    // 开启自动测活的源：保存前立即测活，结果随节点一起持久化；内核系统性失败则不更新
    nodesWithHealth = await runSubscriptionHealthChecks(
      nodesWithHealth,
      (nextConfig.sources ?? []) as SavedSource[],
      onProgress
    );
    assertNodeNameFilterKeepsOutput(nodesWithHealth, nextConfig);
    data.encryptedNodes = encryptJson(nodesWithHealth);
  }

  let resetAutoUpdateState = false;
  if ("autoUpdateInterval" in body) {
    const nextAutoUpdateInterval = normalizeLocalAutoUpdateIntervalSeconds(body.autoUpdateInterval);
    data.autoUpdateInterval = nextAutoUpdateInterval;
    resetAutoUpdateState = current.autoUpdateInterval === null && nextAutoUpdateInterval !== null;
  }

  const row = await prisma.$transaction(async (tx) => {
    if (resetAutoUpdateState) {
      await tx.subscriptionAutoUpdateState.upsert({
        where: { subscriptionId: current.id },
        create: { subscriptionId: current.id },
        update: {
          externalFailureCount: 0,
          failureSourceState: null,
          lastFailedAt: null,
          lastAttemptedAt: null,
          disabledAt: null,
          disabledReason: null,
          disabledPreviousInterval: null,
        },
      });
    }
    return tx.subscription.update({
      where: { id: current.id },
      data,
      include: { autoUpdateState: true },
    });
  });
  return { subscription: formatSubscription(row), nodes: nodesWithHealth };
}

export async function getSubscription(ownerId: string, id: string): Promise<SubscriptionDetail | null> {
  const row = await prisma.subscription.findFirst({
    where: { id, ownerId },
    include: { autoUpdateState: true },
  });
  return row ? formatSubscriptionDetail(row) : null;
}

export async function deleteSubscription(ownerId: string, id: string): Promise<boolean> {
  const row = await prisma.subscription.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!row) return false;
  await prisma.subscription.delete({ where: { id: row.id } });
  return true;
}

export function buildSubscriptionFetchCallbacks() {
  return {
    fetchUrlNodes: async (source: SavedSource) => {
      const imported = await importSourceUrlDirect({
        url: source.content,
        ...(source.userinfoUrl ? { userinfoUrl: source.userinfoUrl } : {}),
        ...(source.userinfoUserAgent ? { userinfoUserAgent: source.userinfoUserAgent } : {}),
      });
      if (imported.ok) {
        return {
          ok: true,
          nodes: imported.parsedNodes,
          errors: imported.parseErrors,
          headers: imported.headers,
        };
      }
      return {
        ok: false,
        nodes: [],
        responseStatus: imported.responseStatus,
        error: imported.error,
        errorInfo: imported.errorInfo,
        publicReason: imported.publicReason ?? undefined,
      };
    },
    fetchUrlUserInfo: async (source: SavedSource) => {
      return fetchSourceUserInfoHeadersDirect(source);
    },
    runHealthCheck: async ({
      source,
      nodes,
      onResult,
    }: {
      source: SavedSource;
      nodes: ParsedNode[];
      onResult?: (nodeName: string, result: NodeHealthResult) => void;
    }) => {
      return runMihomoHealthCheck({
        nodes,
        config: resolveSourceHealthCheck(source),
        ...(onResult ? { onResult } : {}),
      });
    },
  };
}

/** 创建/更新订阅保存前，对开启自动测活的源立即测活并合并结果；内核系统性失败时抛出。
 * onProgress 用于流式回传测活进度（tested/total），不传则一次性完成。
 * 每次都重新探测全部节点，不使用过期结果。 */
async function runSubscriptionHealthChecks(
  nodes: ParsedNode[],
  sources: SavedSource[],
  onProgress?: (tested: number, total: number) => void
): Promise<ParsedNode[]> {
  let next = nodes;
  let tested = 0;
  let total = 0;
  for (const source of sources) {
    if (source.type === "url" && source.useProxyProviders) continue;
    const config = resolveSourceHealthCheck(source);
    if (!config.enabled) continue;
    total += next.filter((node) => getNodeSourceIds(node).includes(source.id)).length;
  }
  if (total > 0 && onProgress) onProgress(0, total);
  for (const source of sources) {
    if (source.type === "url" && source.useProxyProviders) continue;
    const config = resolveSourceHealthCheck(source);
    if (!config.enabled) continue;
    const sourceNodes = next.filter((node) => getNodeSourceIds(node).includes(source.id));
    if (sourceNodes.length === 0) continue;
    const results = await runMihomoHealthCheck({
      nodes: sourceNodes,
      config,
      ...(onProgress
        ? {
            onResult: () => {
              tested += 1;
              onProgress(tested, total);
            },
          }
        : {}),
    });
    next = applyNodeHealthResults(next, source.id, results);
  }
  return next;
}

export function buildSubscriptionCacheExpiry(from: Date): Date {
  return new Date(from.getTime() + CACHE_TTL_SECONDS * 1000);
}

async function persistRefreshSuccess(params: {
  subscriptionId: string;
  expectedUpdatedAt: Date;
  snapshot: RefreshNodeSnapshotResult;
  config: Record<string, unknown>;
  cachedAt: Date;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.updateMany({
      where: { id: params.subscriptionId, updatedAt: params.expectedUpdatedAt },
      data: {
        encryptedNodes: encryptJson(params.snapshot.nodes),
        encryptedConfig: encryptJson({ ...params.config, sources: params.snapshot.savedSources }),
        encryptedSubscriptionInfo: encryptJson(params.snapshot.subscriptionInfo),
        lastUpdatedAt: params.cachedAt,
        cacheExpiresAt: buildSubscriptionCacheExpiry(params.cachedAt),
        updatedAt: params.cachedAt,
      },
    });
    if (updated.count !== 1) return false;
    await tx.subscriptionAutoUpdateState.upsert({
      where: { subscriptionId: params.subscriptionId },
      create: { subscriptionId: params.subscriptionId },
      update: {
        externalFailureCount: 0,
        failureSourceState: null,
        lastFailedAt: null,
        lastAttemptedAt: null,
        disabledAt: null,
        disabledReason: null,
        disabledPreviousInterval: null,
      },
    });
    return true;
  });
}

export async function refreshSubscription(
  ownerId: string,
  id: string,
  onProgress?: (tested: number, total: number) => void
) {
  const row = await prisma.subscription.findFirst({ where: { id, ownerId }, include: { autoUpdateState: true } });
  if (!row) return null;

  const secrets = readSubscriptionSecrets(row);
  const snapshot = await refreshNodeSnapshot({
    config: secrets.config,
    urls: secrets.urls,
    storedNodes: secrets.nodes,
    ...buildSubscriptionFetchCallbacks(),
    ...(onProgress ? { onHealthProgress: onProgress } : {}),
  });
  const refreshResult = prepareRefreshCacheResult({
    config: secrets.config,
    snapshot,
    maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION,
  });

  if (!refreshResult.ok) {
    return {
      ok: false as const,
      response: buildManualRefreshFailureResponse({
        refreshResult,
        maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION,
      }),
    };
  }

  const cachedAt = new Date();
  const persisted = await persistRefreshSuccess({
    subscriptionId: row.id,
    expectedUpdatedAt: row.updatedAt,
    snapshot,
    config: secrets.config,
    cachedAt,
  });
  if (!persisted) {
    return {
      ok: false as const,
      response: {
        body: { error: "Subscription changed while refresh was in progress.", code: "SUBSCRIPTION_CHANGED" },
        status: 409,
      },
    };
  }
  const body = buildManualRefreshSuccessResponseBody({
    subscriptionId: row.id,
    refreshResult,
    snapshot,
    cachedAt,
  });
  return {
    ok: true as const,
    body: { ...body, healthStats: computeNodeHealthStats(snapshot.nodes) },
  };
}

/** 统计快照节点中带测活结果的节点数与通过数（用于刷新完成提示）。 */
export function computeNodeHealthStats(nodes: ParsedNode[]): {
  tested: number;
  ok: number;
  fail: number;
  unsupported: number;
} {
  let tested = 0;
  let ok = 0;
  let fail = 0;
  let unsupported = 0;
  for (const node of nodes) {
    const health = getNodeHealthResults(node);
    if (Object.keys(health).length === 0) continue;
    tested += 1;
    const status = summarizeNodeHealth(node).status;
    if (status === "ok") ok += 1;
    else if (status === "fail") fail += 1;
    else if (status === "unsupported") unsupported += 1;
  }
  return { tested, ok, fail, unsupported };
}

/**
 * 手动测活结果落库：把测活返回的 (节点, 来源) 结果合并进该订阅已持久化节点的 _health，
 * 仅按节点名匹配、只覆盖本次测活涉及的来源条目，其余内容不动。
 * 订阅不存在或不属于该管理员时返回 false。
 */
export async function persistNodeHealthResults(
  ownerId: string,
  id: string,
  results: Array<{ name: string; health: Record<string, NodeHealthResult> }>
): Promise<boolean> {
  const row = await prisma.subscription.findFirst({ where: { id, ownerId } });
  if (!row) return false;
  const secrets = readSubscriptionSecrets(row);
  const byName = new Map(results.map((item) => [item.name, item.health]));
  const nextNodes = secrets.nodes.map((node) => {
    const health = byName.get(node.name);
    if (!health || Object.keys(health).length === 0) return node;
    const record = node as unknown as Record<string, unknown>;
    const existing = (record[HEALTH_RESULTS_KEY] ?? {}) as Record<string, NodeHealthResult>;
    return { ...record, [HEALTH_RESULTS_KEY]: { ...existing, ...health } } as unknown as ParsedNode;
  });
  const changed = nextNodes.some((node, index) => node !== secrets.nodes[index]);
  if (changed) {
    await prisma.subscription.update({
      where: { id: row.id },
      data: { encryptedNodes: encryptJson(nextNodes) },
    });
  }
  return true;
}

export async function generateSubscriptionYaml(token: string): Promise<GeneratedSubscriptionYaml | null> {
  const row = await prisma.subscription.findUnique({ where: { token }, include: { autoUpdateState: true } });
  if (!row) return null;
  const secrets = readSubscriptionSecrets(row);
  const { testUrl, testInterval } = getEffectiveTestOptions(secrets.config);
  const proxyProviders = buildProxyProvidersFromConfig(secrets.config, { testUrl, testInterval });
  const hasProxyProviders = Boolean(proxyProviders && Object.keys(proxyProviders).length > 0);
  if (secrets.nodes.length === 0 && !hasProxyProviders) return null;
  const options = buildGenerateOptionsFromConfig(secrets.config, {
    nodes: secrets.nodes,
    proxyProviders,
  });
  const yaml = generateClashYaml(options);
  await prisma.subscription.update({ where: { id: row.id }, data: { lastAccessedAt: new Date() } });
  return {
    yaml,
    name: row.name,
    subscriptionInfo: secrets.subscriptionInfo,
    cacheExpirySeconds: CACHE_TTL_SECONDS,
    autoUpdateIntervalSeconds: row.autoUpdateInterval,
    isAdmin: true,
    ...(options.nodes.length === 0 && !hasProxyProviders ? { isEmpty: true } : {}),
  };
}
