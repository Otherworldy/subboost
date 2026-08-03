import {
  applyNodeHealthResults,
  getNodeHealthResults,
  HEALTH_RESULTS_KEY,
  normalizeSourceHealthCheck,
  resolveSourceHealthCheck,
  summarizeNodeHealth,
  type NodeHealthResult,
  type SourceHealthCheckConfig,
} from "@subboost/core/subscription/node-health";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import type { ParsedNode } from "@subboost/core/types/node";
import { runMihomoHealthCheck } from "./mihomo-health-check";

export type NodeHealthCheckScope =
  | { kind: "all" }
  | { kind: "source"; sourceId: string }
  | { kind: "node"; nodeName: string };

export type NodeHealthCheckSourceLike = {
  id: string;
  type: string;
  useProxyProviders?: boolean;
  healthCheck?: SourceHealthCheckConfig;
};

export type NodeHealthCheckSummary = {
  tested: number;
  ok: number;
  fail: number;
  unsupported: number;
};

export type NodeHealthCheckResult = {
  nodes: Array<{ name: string; health: Record<string, NodeHealthResult> }>;
  summary: NodeHealthCheckSummary;
};

function normalizeSources(raw: unknown): NodeHealthCheckSourceLike[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeHealthCheckSourceLike[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    if (!id || !type) continue;
    const healthCheck = normalizeSourceHealthCheck(record.healthCheck);
    out.push({
      id,
      type,
      ...(record.useProxyProviders === true ? { useProxyProviders: true } : {}),
      ...(healthCheck ? { healthCheck } : {}),
    });
  }
  return out;
}

/**
 * 手动测活（不受自动开关限制）：按范围选择来源并立即测试，返回按节点归并的结果。
 * 每次调用都重新探测全部节点，不使用过期结果。
 * 传 onNodeResult 时每个节点出结果立即回调（用于流式回显），不传则一次性返回。
 */
export async function runNodeHealthChecks(params: {
  nodes: unknown;
  sources: unknown;
  scope: NodeHealthCheckScope;
  onNodeResult?: (nodeName: string, sourceId: string, result: NodeHealthResult) => void;
}): Promise<NodeHealthCheckResult> {
  const scope = params.scope;
  const nodes = Array.isArray(params.nodes)
    ? (params.nodes.filter((item): item is ParsedNode => Boolean(item) && typeof item === "object") as ParsedNode[])
    : [];
  const sources = normalizeSources(params.sources);

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const targetSourceIds = new Set<string>();

  if (scope.kind === "source") {
    if (!sourceById.has(scope.sourceId)) {
      throw new Error("未知的导入源");
    }
    targetSourceIds.add(scope.sourceId);
  } else if (scope.kind === "node") {
    const node = nodes.find((item) => item.name === scope.nodeName);
    if (!node) throw new Error("未知的节点");
    for (const sourceId of getNodeSourceIds(node)) {
      if (sourceById.has(sourceId)) targetSourceIds.add(sourceId);
    }
    if (targetSourceIds.size === 0) throw new Error("该节点不属于任何导入源，无需测活");
  } else {
    for (const source of sources) {
      targetSourceIds.add(source.id);
    }
  }

  let currentNodes = nodes;
  const summary: NodeHealthCheckSummary = { tested: 0, ok: 0, fail: 0, unsupported: 0 };

  for (const sourceId of targetSourceIds) {
    const source = sourceById.get(sourceId);
    if (!source) continue;
    if (source.type === "url" && source.useProxyProviders) continue;
    const sourceNodes = currentNodes.filter((node) => getNodeSourceIds(node).includes(sourceId));
    if (sourceNodes.length === 0) continue;

    const onNodeResult = params.onNodeResult;
    const results = await runMihomoHealthCheck({
      nodes: sourceNodes,
      config: resolveSourceHealthCheck(source),
      ...(onNodeResult ? { onResult: (nodeName, result) => onNodeResult(nodeName, sourceId, result) } : {}),
    });
    currentNodes = applyNodeHealthResults(currentNodes, sourceId, results);
  }

  const healthByNode = new Map<string, Record<string, NodeHealthResult>>();
  for (const node of currentNodes) {
    const health = Object.fromEntries(
      Object.entries(getNodeHealthResults(node)).filter(([sourceId]) => targetSourceIds.has(sourceId))
    );
    if (Object.keys(health).length === 0) continue;
    healthByNode.set(node.name, health);
    const summaryStatus = summarizeNodeHealth({
      ...(node as unknown as Record<string, unknown>),
      [HEALTH_RESULTS_KEY]: health,
    } as unknown as ParsedNode).status;
    summary.tested += 1;
    if (summaryStatus === "ok") summary.ok += 1;
    else if (summaryStatus === "fail") summary.fail += 1;
    else if (summaryStatus === "unsupported") summary.unsupported += 1;
  }

  return {
    nodes: [...healthByNode.entries()].map(([name, health]) => ({ name, health })),
    summary,
  };
}
