/**
 * CF 优选地址服务端工具：
 * - 三形态输入统一解析为候选 IP 列表（纯 IP / 域名 / 优选 API URL）
 * - 对候选 IP 做 TCPing(443) 测速
 * - 订阅生成时按配置拉取优选 API 并缓存（TTL 内复用，避免每次下载都打 API）
 */
import net from "node:net";
import {
  isCfPreferredApiUrl,
  normalizeCfPreferredSourceConfig,
  type CfPreferredSpec,
} from "@subboost/core/subscription/cf-preferred";
import { resolveHostnameByDoh } from "../subscription/doh-resolver";
import { isPrivateOrReservedIp } from "../subscription/ssrf-ip";

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const TCPING_TIMEOUT_MS = 2000;
const TCPING_CONCURRENCY = 8;
const RESOLVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时

export type CfPreferredCandidate = { ip: string; ms: number | null };

function extractIpv4s(text: string): string[] {
  // 从 API 返回文本中提取 IPv4；cf 优选 API 通常每行一个纯 IP，宽松匹配以兼容 CSV/JSON 片段
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[^0-9.]+/)) {
    if (!IPV4_RE.test(token)) continue;
    const octets = token.split(".").map(Number);
    if (octets.some((n) => n > 255)) continue;
    if (isPrivateOrReservedIp(token)) continue; // SSRF 防护：忽略内网/保留地址
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
    if (out.length >= 64) break;
  }
  return out;
}

/**
 * 把用户配置的优选地址解析为候选 IP 列表。
 * 输入可以是：纯 IPv4 / 域名（DoH 解析）/ http(s) 优选 API 地址（返回文本中提取 IPv4）。
 * 结果已过滤内网与保留地址。
 */
export async function fetchCfPreferredCandidates(
  input: string,
  deps: { fetchImpl?: typeof fetch; dohResolve?: typeof resolveHostnameByDoh } = {},
): Promise<string[]> {
  const value = input.trim();
  if (!value || isPrivateOrReservedIp(value)) return [];

  if (IPV4_RE.test(value)) return [value];

  if (isCfPreferredApiUrl(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return [];
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    if (isPrivateOrReservedIp(parsed.hostname)) return [];

    const fetchImpl = deps.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(value, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "SubBoost/cf-preferred" },
      });
      if (!response.ok) return [];
      return extractIpv4s(await response.text());
    } catch {
      return [];
    }
  }

  // 其余按域名处理：DoH 解析 A 记录
  const dohResolve = deps.dohResolve ?? resolveHostnameByDoh;
  const addresses = await dohResolve(value).catch(() => []);
  return addresses.filter((ip) => IPV4_RE.test(ip) && !isPrivateOrReservedIp(ip));
}

/** 对候选 IP 并发 TCPing 443 端口测延迟；失败为 null */
export function tcpingCandidates(ips: string[]): Promise<CfPreferredCandidate[]> {
  const uniqueIps = [...new Set(ips)];
  const results: CfPreferredCandidate[] = new Array(uniqueIps.length);
  let cursor = 0;

  async function runOne(index: number): Promise<void> {
    const ip = uniqueIps[index];
    results[index] = { ip, ms: await tcpingOnce(ip) };
  }

  async function worker(): Promise<void> {
    while (cursor < uniqueIps.length) {
      const index = cursor;
      cursor += 1;
      await runOne(index);
    }
  }

  const workers = Array.from({ length: Math.min(TCPING_CONCURRENCY, uniqueIps.length) }, () => worker());
  return Promise.all(workers).then(() =>
    results.sort((a, b) => (a.ms ?? Number.POSITIVE_INFINITY) - (b.ms ?? Number.POSITIVE_INFINITY)),
  );
}

function tcpingOnce(ip: string): Promise<number | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const done = (ms: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ms);
    };
    const socket = new net.Socket();
    socket.setTimeout(TCPING_TIMEOUT_MS);
    socket.once("connect", () => done(Date.now() - startedAt));
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
    socket.connect(443, ip);
  });
}

// ---- 订阅生成用：按配置解析最终优选地址（带模块级 TTL 缓存）----

type CacheEntry = { address: string; expiresAt: number };
const resolveCache = new Map<string, CacheEntry>();
// 最后一次成功结果：API 抖动时回退用，不设过期
const lastKnownGood = new Map<string, string>();

export function clearCfPreferredResolveCache(): void {
  resolveCache.clear();
  lastKnownGood.clear();
}

export type ResolveCfPreferredDeps = { fetchImpl?: typeof fetch; dohResolve?: typeof resolveHostnameByDoh };

/**
 * 静态地址直接返回；API URL 拉取后选延迟最低的 IP。
 * 成功结果缓存 TTL（1h）；失败时回退到最后一次成功值且不写缓存（下请求自动重试）。
 */
export async function resolveCfPreferredAddress(
  rawInput: string,
  deps: ResolveCfPreferredDeps = {},
): Promise<string | null> {
  const raw = rawInput.trim();
  if (!raw) return null;
  if (!isCfPreferredApiUrl(raw)) return raw;

  const cached = resolveCache.get(raw);
  if (cached && cached.expiresAt > Date.now()) return cached.address;

  const candidates = await fetchCfPreferredCandidates(raw, deps);
  let address: string | null = null;
  if (candidates.length > 0) {
    const ranked = await tcpingCandidates(candidates.slice(0, 16));
    address = ranked[0]?.ip ?? candidates[0];
  }

  if (address !== null) {
    lastKnownGood.set(raw, address);
    resolveCache.set(raw, { address, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
    return address;
  }
  return lastKnownGood.get(raw) ?? null;
}

/**
 * 与 buildGenerateOptionsFromConfig 配套：读 config.sources[].cfPreferred，
 * 已开启源的 API URL 解析成最新 IP。
 */
export async function prepareCfPreferredRules(
  config: Record<string, unknown>,
  deps: ResolveCfPreferredDeps = {},
): Promise<Record<string, CfPreferredSpec> | undefined> {
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const out: Record<string, CfPreferredSpec> = {};
  for (const item of sources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const cfg = normalizeCfPreferredSourceConfig(record.cfPreferred);
    if (!id || !cfg?.enabled || !cfg.address || out[id]) continue;
    const resolved = await resolveCfPreferredAddress(cfg.address, deps);
    if (resolved) out[id] = { address: resolved, mode: cfg.mode === "replace" ? "replace" : "clone" };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
