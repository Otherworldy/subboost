import type {
  CfPreferredCarrier,
  CfPreferredMode,
  CfPreferredPoolConfig,
  CfPreferredPoolEntry,
  CfPreferredPoolProbeLog,
} from "@subboost/core/types/config";
import { CF_PREFERRED_CARRIERS } from "@subboost/core/types/config";
import type { CfPreferredSpec } from "./cf-preferred";

export const DEFAULT_CF_PREFERRED_POOL: CfPreferredPoolConfig = {
  enabled: false,
  mode: "clone",
  probeIntervalMinutes: 15,
  entries: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asCarrier(value: unknown): CfPreferredCarrier {
  return typeof value === "string" && (CF_PREFERRED_CARRIERS as readonly string[]).includes(value)
    ? (value as CfPreferredCarrier)
    : "global";
}

/** 旧数据 role=standby/circuit_open 视为关闭，其余默认启用 */
function asEnabled(value: Record<string, unknown>): boolean {
  if (typeof value.enabled === "boolean") return value.enabled;
  return value.role !== "standby" && value.role !== "circuit_open";
}

function asMode(value: unknown): CfPreferredMode {
  return value === "replace" ? "replace" : "clone";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function entryId(carrier: CfPreferredCarrier, address: string, explicit?: string): string {
  const given = typeof explicit === "string" ? explicit.trim() : "";
  if (given) return given.slice(0, 80);
  return `cfp-${carrier}-${address.replace(/[^a-zA-Z0-9]+/g, "-")}`.slice(0, 80);
}

function asProbeMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  return undefined;
}

/** 注入排序：有浏览器结果用浏览器（含不通），否则服务器，再回退旧 ms */
export function effectivePoolEntryMs(
  entry: Pick<CfPreferredPoolEntry, "ms" | "browserMs" | "serverMs">,
): number | null | undefined {
  if (entry.browserMs !== undefined) return entry.browserMs;
  if (entry.serverMs !== undefined) return entry.serverMs;
  return entry.ms;
}

export function withPoolEntryProbe(
  entry: CfPreferredPoolEntry,
  from: "browser" | "server",
  ms: number | null,
  probedAt: string,
): CfPreferredPoolEntry {
  const next: CfPreferredPoolEntry =
    from === "browser"
      ? { ...entry, browserMs: ms, probedAt, probeFrom: from }
      : { ...entry, serverMs: ms, probedAt, probeFrom: from };
  const effective = effectivePoolEntryMs(next);
  return effective !== undefined ? { ...next, ms: effective } : next;
}

function normalizeEntry(value: unknown): CfPreferredPoolEntry | undefined {
  if (!isRecord(value)) return undefined;
  const address = typeof value.address === "string" ? value.address.trim() : "";
  if (!address || address.length > 256 || /^https?:\/\//i.test(address)) return undefined;
  const carrier = asCarrier(value.carrier);
  const pop = typeof value.pop === "string" ? value.pop.trim().slice(0, 32) : "";
  const ms = asProbeMs(value.ms);
  let browserMs = asProbeMs(value.browserMs);
  let serverMs = asProbeMs(value.serverMs);
  const probedAt = typeof value.probedAt === "string" ? value.probedAt.trim().slice(0, 40) : "";
  const probeFrom = value.probeFrom === "browser" || value.probeFrom === "server" ? value.probeFrom : undefined;
  if (browserMs === undefined && serverMs === undefined && ms !== undefined) {
    if (probeFrom === "browser") browserMs = ms;
    else serverMs = ms;
  }
  const effective = effectivePoolEntryMs({ ms, browserMs, serverMs });
  return {
    id: entryId(carrier, address, typeof value.id === "string" ? value.id : undefined),
    address,
    carrier,
    enabled: asEnabled(value),
    ...(pop ? { pop } : {}),
    ...(effective !== undefined ? { ms: effective } : {}),
    ...(browserMs !== undefined ? { browserMs } : {}),
    ...(serverMs !== undefined ? { serverMs } : {}),
    ...(probedAt ? { probedAt } : {}),
    ...(probeFrom ? { probeFrom } : {}),
  };
}

function normalizeProbeLog(value: unknown): CfPreferredPoolProbeLog | undefined {
  if (!isRecord(value) || typeof value.at !== "string" || !value.at.trim()) return undefined;
  const ok = clampInt(value.ok, 0, 1_000_000, 0);
  const failed = clampInt(value.failed, 0, 1_000_000, 0);
  const raw = typeof value.message === "string" ? value.message.trim() : "";
  const message =
    /熔断|恢复|热备/.test(raw) ? `探活完成：${ok} 通 / ${failed} 失败` : raw.slice(0, 200);
  return { at: value.at.trim().slice(0, 40), ok, failed, message };
}

export function parseCfPreferredPoolJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function normalizeCfPreferredPoolConfig(value: unknown): CfPreferredPoolConfig {
  const parsed = parseCfPreferredPoolJson(value);
  if (!isRecord(parsed)) return { ...DEFAULT_CF_PREFERRED_POOL, entries: [] };
  const seen = new Set<string>();
  const entries: CfPreferredPoolEntry[] = [];
  if (Array.isArray(parsed.entries)) {
    for (const item of parsed.entries) {
      const entry = normalizeEntry(item);
      if (!entry || seen.has(entry.address)) continue;
      seen.add(entry.address);
      entries.push(entry);
    }
  }
  const lastProbe = normalizeProbeLog(parsed.lastProbe);
  return {
    enabled: parsed.enabled === true,
    mode: asMode(parsed.mode),
    probeIntervalMinutes: clampInt(parsed.probeIntervalMinutes, 5, 1440, 15),
    entries,
    ...(lastProbe ? { lastProbe } : {}),
  };
}

/** 池内已启用入口，按延迟排序。不看 pool.enabled（源上「继承平台池」仍要用这份列表） */
export function poolEntryAddresses(pool: CfPreferredPoolConfig | undefined): string[] {
  if (!pool) return [];
  return pool.entries
    .filter((entry) => entry.enabled)
    .sort((a, b) => (effectivePoolEntryMs(a) ?? 9_999) - (effectivePoolEntryMs(b) ?? 9_999))
    .map((entry) => entry.address);
}

/** 平台池总开关打开时，给未覆盖的源自动注入 */
export function activePoolAddresses(pool: CfPreferredPoolConfig | undefined): string[] {
  return pool?.enabled ? poolEntryAddresses(pool) : [];
}

function sourceCfMode(preferred: Record<string, unknown> | undefined, fallback: CfPreferredMode): CfPreferredMode {
  if (preferred?.mode === "replace" || preferred?.mode === "clone") return preferred.mode;
  return fallback;
}

/**
 * 把平台入口池合并进各源规则。
 * - 源已勾选 addresses（含空数组=全不选）视为覆盖，不改。
 * - 源打开了 CF 且继承平台池：用池内已启用入口，不要求池总开关打开。
 * - 池总开关打开：给其余未覆盖的源也注入同一组入口。
 */
export function mergePlatformCfPreferredPool(
  sources: unknown,
  existing: Record<string, CfPreferredSpec> | undefined,
  pool: CfPreferredPoolConfig | undefined,
): Record<string, CfPreferredSpec> | undefined {
  const inheritAddrs = poolEntryAddresses(pool);
  const autoAddrs = pool?.enabled ? inheritAddrs : [];
  if (inheritAddrs.length === 0) return existing;
  const out: Record<string, CfPreferredSpec> = { ...(existing ?? {}) };
  if (!Array.isArray(sources)) return Object.keys(out).length > 0 ? out : undefined;
  let injected = false;
  for (const item of sources) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const current = existing?.[id];
    const preferred = isRecord(item.cfPreferred) ? item.cfPreferred : undefined;
    if (Array.isArray(preferred?.addresses)) continue;
    if (current?.addresses && current.addresses.length > 0) continue;
    if (preferred?.strategy === "custom") continue;
    const sourceEnabled = preferred?.enabled === true;
    const addrs = sourceEnabled ? inheritAddrs : autoAddrs;
    if (addrs.length === 0) continue;
    const mode = sourceCfMode(preferred, pool!.mode);
    out[id] = { address: addrs[0], addresses: addrs, mode };
    injected = true;
  }
  if (!injected) return existing;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ParsedCfPreferredBatchLine {
  address: string;
  label?: string;
  carrier: CfPreferredCarrier;
}

/**
 * 批量解析 CF 优选文本（支持 IP#备注、IP,备注 或 纯 IP，一行一个）。
 * 自动从备注中识别运营商（电信、联通、移动、三网），并过滤非法格式与去重。
 */
export function parseCfPreferredBatchLines(
  text: string,
  fallbackCarrier: CfPreferredCarrier = "optimized",
): ParsedCfPreferredBatchLine[] {
  if (!text || typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const results: ParsedCfPreferredBatchLine[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith(";") || line.startsWith("#")) continue;

    let address = "";
    let label = "";

    if (line.includes("#")) {
      const parts = line.split("#");
      address = (parts[0] || "").trim();
      label = parts.slice(1).join("#").trim();
    } else if (line.includes(",") && !line.includes(":")) {
      const parts = line.split(",");
      address = (parts[0] || "").trim();
      label = parts.slice(1).join(",").trim();
    } else {
      address = line.trim();
    }

    if (!address) continue;
    address = address.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
    if (!address || address.length > 256) continue;

    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let carrier = fallbackCarrier;
    const lowerLabel = label.toLowerCase();
    if (label.includes("电信") || lowerLabel.includes("ct") || lowerLabel.includes("telecom")) {
      carrier = "telecom";
    } else if (label.includes("联通") || lowerLabel.includes("cu") || lowerLabel.includes("unicom")) {
      carrier = "unicom";
    } else if (
      label.includes("移动") ||
      lowerLabel.includes("cm") ||
      lowerLabel.includes("cmcc") ||
      lowerLabel.includes("mobile")
    ) {
      carrier = "mobile";
    } else if (
      label.includes("三网") ||
      label.includes("优化") ||
      lowerLabel.includes("anycast") ||
      lowerLabel.includes("optimized")
    ) {
      carrier = "optimized";
    } else if (label.includes("兜底") || label.includes("海外") || lowerLabel.includes("global")) {
      carrier = "global";
    }

    results.push({
      address,
      ...(label ? { label } : {}),
      carrier,
    });
  }

  return results;
}

