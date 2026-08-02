import { generateClashYaml } from "@subboost/core/generator";
import {
  buildGenerateOptionsFromConfig,
  getEffectiveTestOptions,
} from "@subboost/core/subscription/config-utils";
import { filterNodesByHealth } from "@subboost/core/subscription/node-health";
import { buildProxyProvidersFromConfig } from "@subboost/core/subscription/proxy-providers";
import { resolveNodeNameFilter } from "@subboost/core/subscription/node-name-filter";
import type { ParsedNode } from "@subboost/core/types/node";
import type { SubscriptionResponseInfo } from "@subboost/core/subscription/subscription-response-info";
import type { RefreshNodeSnapshotResult } from "./refresh-node-snapshot";

export type RefreshCacheFailureReason =
  | "all_sources_failed"
  | "empty_result"
  | "node_quota_exceeded";

export type RefreshCacheEntry = {
  nodes: ParsedNode[];
  subscriptionInfo: SubscriptionResponseInfo;
  generatedYaml: string;
};

export type PreparedRefreshCacheResult =
  | {
      ok: true;
      cacheEntry: RefreshCacheEntry;
      generatedYaml: string;
      // 原始快照节点数（页面保留全部节点）
      nodeCount: number;
      // 通过自动测活的节点数（生成侧可用数）
      healthNodeCount: number;
      proxyProviders?: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: RefreshCacheFailureReason;
      proxyProviders?: Record<string, unknown>;
      nodeCount: number;
      healthNodeCount: number;
      maxNodesPerSubscription?: number;
    };

export function prepareRefreshCacheResult(params: {
  config: Record<string, unknown>;
  snapshot: RefreshNodeSnapshotResult;
  maxNodesPerSubscription: number;
  proxyProviders?: Record<string, unknown>;
}): PreparedRefreshCacheResult {
  const { testUrl, testInterval } = getEffectiveTestOptions(params.config);
  const proxyProviders =
    params.proxyProviders ??
    buildProxyProvidersFromConfig(params.config, {
      testUrl,
      testInterval,
    });
  const hasProxyProviders = Boolean(
    proxyProviders && Object.keys(proxyProviders).length > 0
  );
  const healthFilteredNodes = filterNodesByHealth(params.snapshot.nodes, params.config);
  const common = {
    proxyProviders,
    nodeCount: params.snapshot.nodes.length,
    healthNodeCount: healthFilteredNodes.length,
  };

  if (params.snapshot.refreshableSourceCount > 0 && params.snapshot.refreshedSourceCount === 0) {
    return {
      ok: false,
      reason: "all_sources_failed",
      ...common,
    };
  }

  // 原始快照为空：没有可保存的节点
  if (params.snapshot.nodes.length === 0 && !hasProxyProviders) {
    return {
      ok: false,
      reason: "empty_result",
      ...common,
    };
  }

  if (params.snapshot.nodes.length > params.maxNodesPerSubscription) {
    return {
      ok: false,
      reason: "node_quota_exceeded",
      maxNodesPerSubscription: params.maxNodesPerSubscription,
      ...common,
    };
  }

  // 自动测活后仍有节点，但用户名称过滤把它们全部排除：视为用户过滤错误（保留旧快照）
  const nodeNameFilterResult = resolveNodeNameFilter(healthFilteredNodes, params.config.nodeNameFilter);
  if (nodeNameFilterResult.effectiveCount === 0 && healthFilteredNodes.length > 0 && !hasProxyProviders) {
    return {
      ok: false,
      reason: "empty_result",
      ...common,
    };
  }

  const generatedYaml = generateClashYaml(
    buildGenerateOptionsFromConfig(params.config, {
      // 共享生成入口内部会再次按测活状态过滤并剥离内部字段
      nodes: params.snapshot.nodes,
      proxyProviders,
    })
  );

  return {
    ok: true,
    ...common,
    generatedYaml,
    cacheEntry: {
      // 页面/节点管理保留全部节点（含测活结果）
      nodes: params.snapshot.nodes,
      subscriptionInfo: params.snapshot.subscriptionInfo,
      generatedYaml,
    },
  };
}
