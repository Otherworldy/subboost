import type { ParsedNode } from "../types/node";
import { ORIGIN_NAME_KEY, SOURCE_IDS_KEY, getNodeSourceIds } from "./node-source-state";

/**
 * 订阅源测活（health check）配置与节点内部结果。
 *
 * 配置按订阅源保存（SavedSource.healthCheck / 编辑器 SubscriptionSource.healthCheck），
 * 旧配置没有该字段时默认关闭。结果以 `_health` 内部字段按 sourceId 附着在节点上，
 * 生成配置前会按“自动测活开启的源”过滤，并在输出时剥离所有 `_` 内部字段。
 */

export const DEFAULT_HEALTH_CHECK = {
  url: "http://cp.cloudflare.com/generate_204",
  maxDelayMs: 5000,
  // 默认 20 并发：兼顾批量测速速度；触发节点服务器限流时由失败重试兜底。
  concurrency: 20,
} as const;

export const HEALTH_CHECK_MAX_DELAY_MIN_MS = 100;
export const HEALTH_CHECK_MAX_DELAY_MAX_MS = 60000;
export const HEALTH_CHECK_CONCURRENCY_MIN = 1;
export const HEALTH_CHECK_CONCURRENCY_MAX = 100;

export type NodeHealthStatus = "ok" | "fail" | "unsupported";

export type SourceHealthCheckConfig = {
  enabled?: boolean;
  url?: string;
  maxDelayMs?: number;
  concurrency?: number;
};

export type NodeHealthResult = {
  status: NodeHealthStatus;
  delayMs?: number;
  checkedAt: string;
};

export const HEALTH_RESULTS_KEY = "_health";

function normalizeBoundedInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

/** 仅允许 HTTP(S)；接受缺省协议的主机名（如 www.google.com），自动补 https://。 */
export function normalizeHealthCheckUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const tryParse = (raw: string): URL | null => {
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  };

  const url = tryParse(trimmed) ?? (trimmed.includes("://") ? null : tryParse(`https://${trimmed}`));
  if (!url) return undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.toString();
}

export function normalizeSourceHealthCheck(value: unknown): SourceHealthCheckConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const out: SourceHealthCheckConfig = {};
  if (typeof record.enabled === "boolean") out.enabled = record.enabled;
  const url = normalizeHealthCheckUrl(record.url);
  if (url) out.url = url;
  const maxDelayMs = normalizeBoundedInt(
    record.maxDelayMs,
    HEALTH_CHECK_MAX_DELAY_MIN_MS,
    HEALTH_CHECK_MAX_DELAY_MAX_MS
  );
  if (maxDelayMs !== undefined) out.maxDelayMs = maxDelayMs;
  const concurrency = normalizeBoundedInt(
    record.concurrency,
    HEALTH_CHECK_CONCURRENCY_MIN,
    HEALTH_CHECK_CONCURRENCY_MAX
  );
  if (concurrency !== undefined) out.concurrency = concurrency;

  if (Object.keys(out).length === 0) return undefined;
  return out;
}

export type ResolvedSourceHealthCheck = Required<SourceHealthCheckConfig>;

export function resolveSourceHealthCheck(source?: {
  healthCheck?: SourceHealthCheckConfig;
}): ResolvedSourceHealthCheck {
  const cfg = source?.healthCheck;
  return {
    enabled: cfg?.enabled ?? false,
    url: cfg?.url ?? DEFAULT_HEALTH_CHECK.url,
    maxDelayMs: cfg?.maxDelayMs ?? DEFAULT_HEALTH_CHECK.maxDelayMs,
    concurrency: cfg?.concurrency ?? DEFAULT_HEALTH_CHECK.concurrency,
  };
}

export function getHealthCheckCacheConfigKey(source?: {
  healthCheck?: SourceHealthCheckConfig;
}): string {
  const { url, maxDelayMs, concurrency } = resolveSourceHealthCheck(source);
  return `${url}\u0000${maxDelayMs}\u0000${concurrency}`;
}

export function getNodeHealthResults(node: ParsedNode): Record<string, NodeHealthResult> {
  const record = node as unknown as Record<string, unknown>;
  const raw = record[HEALTH_RESULTS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: Record<string, NodeHealthResult> = {};
  for (const [sourceId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const recordValue = value as Record<string, unknown>;
    const status = recordValue.status;
    if (status !== "ok" && status !== "fail" && status !== "unsupported") continue;
    const checkedAt = recordValue.checkedAt;
    if (typeof checkedAt !== "string" || !checkedAt) continue;
    const delayMs = recordValue.delayMs;
    out[sourceId] = {
      status,
      ...(typeof delayMs === "number" && Number.isFinite(delayMs) ? { delayMs } : {}),
      checkedAt,
    };
  }
  return out;
}

export function withNodeHealthResult(
  node: ParsedNode,
  sourceId: string,
  result: NodeHealthResult
): ParsedNode {
  const record = node as unknown as Record<string, unknown>;
  return {
    ...record,
    [HEALTH_RESULTS_KEY]: { ...getNodeHealthResults(node), [sourceId]: result },
  } as unknown as ParsedNode;
}

export function withoutNodeHealthResultsForSources(
  node: ParsedNode,
  sourceIds: Iterable<string>
): ParsedNode {
  const record = node as unknown as Record<string, unknown>;
  const results = getNodeHealthResults(node);
  const removed = new Set(sourceIds);
  let changed = false;
  for (const id of Object.keys(results)) {
    if (removed.has(id)) {
      delete results[id];
      changed = true;
    }
  }
  if (!changed) return node;
  if (Object.keys(results).length === 0) {
    const { [HEALTH_RESULTS_KEY]: _removed, ...rest } = record;
    return rest as unknown as ParsedNode;
  }
  return { ...record, [HEALTH_RESULTS_KEY]: results } as unknown as ParsedNode;
}

/** 按节点名把一次测活结果写入指定来源（节点名在订阅状态内唯一）。 */
export function applyNodeHealthResults(
  nodes: ParsedNode[],
  sourceId: string,
  results: ReadonlyMap<string, NodeHealthResult>
): ParsedNode[] {
  return nodes.map((node) => {
    const result = results.get(node.name);
    if (!result) return node;
    return withNodeHealthResult(node, sourceId, result);
  });
}

/** 移除指定来源的测活结果（来源被分离/删除时清理）。 */
export function stripNodeHealthResultsForSource(nodes: ParsedNode[], sourceId: string): ParsedNode[] {
  return nodes.map((node) => withoutNodeHealthResultsForSources(node, [sourceId]));
}

export type NodeHealthSummary = {
  status: NodeHealthStatus | "untested";
  delayMs?: number;
  checkedAt?: string;
};

/** 节点管理展示用：取所有来源结果中最快成功延迟；无成功时按失败/不支持/未测归纳。 */
export function summarizeNodeHealth(node: ParsedNode): NodeHealthSummary {
  const results = Object.values(getNodeHealthResults(node));
  if (results.length === 0) return { status: "untested" };

  let bestDelay: number | undefined;
  let bestCheckedAt: string | undefined;
  let latestCheckedAt: string | undefined;
  let hasFail = false;
  let hasUnsupported = false;

  for (const result of results) {
    if (result.checkedAt > (latestCheckedAt ?? "")) latestCheckedAt = result.checkedAt;
    if (result.status === "ok") {
      if (bestDelay === undefined || (result.delayMs ?? Number.POSITIVE_INFINITY) < bestDelay) {
        bestDelay = result.delayMs;
        bestCheckedAt = result.checkedAt;
      }
    } else if (result.status === "fail") {
      hasFail = true;
    } else {
      hasUnsupported = true;
    }
  }

  if (bestDelay !== undefined) return { status: "ok", delayMs: bestDelay, checkedAt: bestCheckedAt };
  if (hasFail) return { status: "fail", checkedAt: latestCheckedAt };
  if (hasUnsupported) return { status: "unsupported", checkedAt: latestCheckedAt };
  return { status: "untested" };
}

/**
 * 下游可见性：节点任一来源未知、任一来源未测（无结果）、或任一来源测活成功即可见。
 * 仅当“开启自动测活”的来源全部有测活结果且都显式失败/不支持时才隐藏。
 * 关闭自动测活的来源不参与过滤：即使残留手动测活的失败结果，也不影响节点可见性。
 */
export function isNodeVisibleToDownstream(
  node: ParsedNode,
  sources: ReadonlyArray<{ id: string; healthCheck?: SourceHealthCheckConfig }>
): boolean {
  const sourceIds = getNodeSourceIds(node);
  if (sourceIds.length === 0) return true;

  const knownIds = new Set<string>();
  const filteringSourceIds = new Set<string>();
  for (const source of sources) {
    const id = (source.id || "").trim();
    if (!id) continue;
    knownIds.add(id);
    if (resolveSourceHealthCheck(source).enabled) filteringSourceIds.add(id);
  }

  const results = getNodeHealthResults(node);
  for (const sourceId of sourceIds) {
    if (!knownIds.has(sourceId)) return true;
    if (!filteringSourceIds.has(sourceId)) return true;
    const result = results[sourceId];
    if (!result || result.status === "ok") return true;
  }

  return false;
}

/** 从持久化 config.sources 提取参与测活过滤的来源描述。 */
export function getNodeHealthSourceDescriptors(
  config: Record<string, unknown>
): Array<{ id: string; healthCheck?: SourceHealthCheckConfig }> {
  const rawSources = config.sources;
  if (!Array.isArray(rawSources)) return [];

  const out: Array<{ id: string; healthCheck?: SourceHealthCheckConfig }> = [];
  for (const item of rawSources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const healthCheck = normalizeSourceHealthCheck(record.healthCheck);
    out.push(healthCheck ? { id, healthCheck } : { id });
  }
  return out;
}

export function filterNodesByHealth(nodes: ParsedNode[], config: Record<string, unknown>): ParsedNode[] {
  const sources = getNodeHealthSourceDescriptors(config);
  return nodes.filter((node) => isNodeVisibleToDownstream(node, sources));
}

/** 剥离测活/来源/原名内部字段（生成入口使用；YAML 序列化另有 `_` 前缀过滤兜底）。 */
export function stripNodeHealthFields(node: ParsedNode): ParsedNode {
  const record = node as unknown as Record<string, unknown>;
  let changed = false;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === HEALTH_RESULTS_KEY || key === SOURCE_IDS_KEY || key === ORIGIN_NAME_KEY) {
      changed = true;
      continue;
    }
    sanitized[key] = value;
  }
  return changed ? (sanitized as ParsedNode) : node;
}

export function stripNodeHealthFieldsFromList(nodes: ParsedNode[]): ParsedNode[] {
  return nodes.map(stripNodeHealthFields);
}
