/**
 * CF 优选节点生成
 *
 * 套 Cloudflare CDN 的节点（vless/vmess/trojan + WS/gRPC 等 + TLS + CF 端口）具有
 * "入口与身份分离"的特性：任意 CF 边缘 IP 都能通过 SNI/Host 路由到原服务器。
 * 按订阅源为命中节点生成优选副本（clone）或直接替换入口（replace）。
 */
import type {
  CfPreferredCarrier,
  CfPreferredCustomEntry,
  CfPreferredMode,
  CfPreferredPoolConfig,
  CfPreferredSourceConfig,
} from "@subboost/core/types/config";
import { CF_PREFERRED_CARRIERS } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import { mergePlatformCfPreferredPool } from "./cf-preferred-pool";

/** Cloudflare 支持的 HTTPS 端口；不在白名单的端口不可能是 CF 入口 */
export const CF_TLS_PORTS: ReadonlySet<number> = new Set([443, 2053, 2083, 2087, 2096, 8443]);

export type CfPreferredSpecEntry = { address: string; carrier?: CfPreferredCarrier };
export type CfPreferredSpec = {
  address: string;
  addresses?: string[];
  entries?: CfPreferredSpecEntry[];
  mode: CfPreferredMode;
};

export const CF_PREFERRED_CLONE_TAGS: Record<CfPreferredCarrier, string> = {
  optimized: "三网优选",
  telecom: "电信优选",
  unicom: "联通优选",
  mobile: "移动优选",
  global: "海外优选",
};

// ponytail: 不对 CF 优选节点设置人工上限
export const MAX_CF_PREFERRED_ADDRESSES = 100_000;

export function normalizeCfPreferredAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const addr = item.trim();
    if (!addr || isCfPreferredApiUrl(addr) || seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

export function specAddresses(spec: CfPreferredSpec): string[] {
  if (spec.entries && spec.entries.length > 0) return spec.entries.map((entry) => entry.address);
  if (spec.addresses && spec.addresses.length > 0) return spec.addresses;
  const address = typeof spec.address === "string" ? spec.address.trim() : "";
  return address ? [address] : [];
}

export function specEntries(spec: CfPreferredSpec): CfPreferredSpecEntry[] {
  if (spec.entries && spec.entries.length > 0) return spec.entries;
  return specAddresses(spec).map((address) => ({ address }));
}

const CDN_CAPABLE_TYPES: ReadonlySet<string> = new Set(["vmess", "vless", "trojan"]);
const CDN_NETWORKS: ReadonlySet<string> = new Set(["ws", "grpc", "h2", "http", "xhttp"]);

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^\[[0-9a-f:]+\]$/i;

export function isCfPreferredApiUrl(address: string): boolean {
  return /^https?:\/\//i.test(address.trim());
}

function isDomainLike(value: string): boolean {
  return DOMAIN_RE.test(value) && !IPV4_RE.test(value) && !IPV6_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 是否为"套 CF CDN"形态：CDN 能力协议 + TLS + CDN 传输层 + CF 端口，且能确定 SNI 身份 */
export function isCfCdnNode(node: ParsedNode): boolean {
  const r = node as Record<string, unknown>;
  if (!node || typeof node !== "object") return false;
  if (!CDN_CAPABLE_TYPES.has(node.type)) return false;
  if (typeof node.port !== "number" || !CF_TLS_PORTS.has(node.port)) return false;
  if (r["reality-opts"]) return false; // REALITY 是直连伪装架构，与 CF 无关
  if (r.tls !== true && node.type !== "trojan") return false; // trojan 隐含 TLS
  if (r.network !== undefined && !CDN_NETWORKS.has(String(r.network))) return false;
  const hasIdentity =
    typeof r.sni === "string" ||
    typeof r.servername === "string" ||
    isDomainLike(node.server ?? "");
  return hasIdentity;
}

/** 把原域名固定到 sni/servername/ws Host，保证换入口后 CF 仍能路由与校验证书 */
function withCfIdentityFields(record: Record<string, unknown>, identity: string): void {
  const type = String(record.type ?? "");
  if (type === "trojan" && typeof record.sni !== "string") record.sni = identity;
  if ((type === "vmess" || type === "vless") && typeof record.servername !== "string") {
    record.servername = identity;
  }
  if (record.network === "ws" && record["ws-opts"] && typeof record["ws-opts"] === "object") {
    const ws = record["ws-opts"] as Record<string, unknown>;
    const headers = { ...((ws.headers as Record<string, string> | undefined) ?? {}) };
    if (!headers.Host && !headers.host) headers.Host = identity;
    ws.headers = headers;
    record["ws-opts"] = ws;
  }
}

function rewriteCfServer(node: ParsedNode, address: string): Record<string, unknown> {
  const next = { ...(node as unknown as Record<string, unknown>) };
  withCfIdentityFields(next, String(next.sni ?? next.servername ?? node.server));
  next.server = address;
  return next;
}

export const CF_PREFERRED_MARK_KEY = "_cfPreferred";
export const CF_PREFERRED_OF_KEY = "_cfPreferredOf";

export function getCfPreferredMark(node: ParsedNode): CfPreferredMode | undefined {
  const mark = (node as unknown as Record<string, unknown>)[CF_PREFERRED_MARK_KEY];
  return mark === "clone" || mark === "replace" ? mark : undefined;
}

export function getCfPreferredOf(node: ParsedNode): string | undefined {
  const value = (node as unknown as Record<string, unknown>)[CF_PREFERRED_OF_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function originKey(node: ParsedNode): string {
  const origin = (node as unknown as Record<string, unknown>)._originName;
  return typeof origin === "string" && origin.trim() ? origin.trim() : node.name;
}

const MANAGED_CF_SUFFIX_RE = /-(?:CF\d*|(?:三网|电信|联通|移动|海外)?优选\d+)(?:-\d+)?$/;

function stripManagedCfSuffix(name: string): string {
  return name.replace(MANAGED_CF_SUFFIX_RE, "");
}

function cloneTargetKey(node: ParsedNode): string {
  return getCfPreferredOf(node) ?? stripManagedCfSuffix(node.name);
}

function cfNameBase(node: ParsedNode): string {
  return getCfPreferredOf(node) ?? stripManagedCfSuffix(node.name);
}

function cloneTag(carrier?: CfPreferredCarrier): string {
  return carrier ? CF_PREFERRED_CLONE_TAGS[carrier] : "优选";
}

function groupCloneName(
  baseName: string,
  tag: string,
  n: number,
  used: Set<string>,
  currentName?: string,
): string {
  const preferred = `${baseName}-${tag}${n}`;
  if (currentName === preferred) return preferred;
  if (currentName) used.delete(currentName);
  if (!used.has(preferred)) return preferred;
  let extra = 2;
  let candidate = `${preferred}-${extra}`;
  while (used.has(candidate)) {
    extra += 1;
    candidate = `${preferred}-${extra}`;
  }
  return candidate;
}

function takeGroupCloneName(
  baseName: string,
  tag: string,
  seq: Map<string, number>,
  used: Set<string>,
  currentName?: string,
): string {
  const n = (seq.get(tag) ?? 0) + 1;
  seq.set(tag, n);
  return groupCloneName(baseName, tag, n, used, currentName);
}

function isManagedCfCloneName(name: string, origin: string): boolean {
  if (!name.startsWith(`${origin}-`)) return false;
  return /^(CF\d*|(?:三网|电信|联通|移动|海外)?优选\d+)(-\d+)?$/.test(name.slice(origin.length + 1));
}

function withCloneName(node: ParsedNode, name: string): ParsedNode {
  if (node.name === name) return node;
  return { ...(node as unknown as Record<string, unknown>), name, _originName: name } as unknown as ParsedNode;
}

function asCarrier(value: unknown): CfPreferredCarrier | undefined {
  return typeof value === "string" && (CF_PREFERRED_CARRIERS as readonly string[]).includes(value)
    ? (value as CfPreferredCarrier)
    : undefined;
}

/** 为单个套 CF 节点构建优选副本（原节点名加 -CF 后缀） */
export function buildCfPreferredClone(node: ParsedNode, address: string, name = `${node.name}-CF`): ParsedNode {
  const clone = rewriteCfServer(node, address);
  clone.name = name;
  clone[CF_PREFERRED_MARK_KEY] = "clone";
  clone[CF_PREFERRED_OF_KEY] = originKey(node);
  clone._originName = clone.name;
  delete clone._health; // 副本未独立测活，不要展示原节点延迟
  return clone as unknown as ParsedNode;
}

function withCloneAddress(node: ParsedNode, address: string): ParsedNode {
  if (node.server === address) return node;
  const next = rewriteCfServer(node, address);
  next.name = node.name;
  next[CF_PREFERRED_MARK_KEY] = "clone";
  next[CF_PREFERRED_OF_KEY] = cloneTargetKey(node);
  return next as unknown as ParsedNode;
}

/** 直接替换原节点入口 */
export function buildCfReplacedNode(node: ParsedNode, address: string): ParsedNode {
  const replaced = rewriteCfServer(node, address);
  replaced[CF_PREFERRED_MARK_KEY] = "replace";
  replaced[CF_PREFERRED_OF_KEY] = getCfPreferredOf(node) ?? stripManagedCfSuffix(node.name);
  return replaced as unknown as ParsedNode;
}

function normalizeCustomLines(value: unknown): CfPreferredCustomEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CfPreferredCustomEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.address !== "string") continue;
    const address = item.address.trim();
    if (!address || isCfPreferredApiUrl(address) || seen.has(address)) continue;
    seen.add(address);
    const label = typeof item.label === "string" ? item.label.trim().slice(0, 64) : "";
    const carrier = asCarrier(item.carrier);
    const ms =
      item.ms === null
        ? null
        : typeof item.ms === "number" && Number.isFinite(item.ms)
          ? Math.max(0, Math.round(item.ms))
          : undefined;
    out.push({
      address,
      ...(label ? { label } : {}),
      ...(carrier ? { carrier } : {}),
      ...(ms !== undefined ? { ms } : {}),
    });
  }
  return out;
}

export function normalizeCfPreferredSourceConfig(value: unknown): CfPreferredSourceConfig | undefined {
  if (!isRecord(value)) return undefined;
  const address = typeof value.address === "string" ? value.address.trim() : "";
  const hasAddresses = Array.isArray(value.addresses);
  const addresses = normalizeCfPreferredAddresses(value.addresses);
  const mode: CfPreferredMode = value.mode === "replace" ? "replace" : "clone";
  const enabled = value.enabled === true;
  const strategy = value.strategy === "custom" || value.strategy === "platform" ? value.strategy : undefined;
  const customLines = normalizeCustomLines(value.customLines);
  const rawCustomText = typeof value.rawCustomText === "string" ? value.rawCustomText : "";
  if (!enabled && !address && !hasAddresses && !strategy && !customLines?.length && !rawCustomText.trim()) {
    return undefined;
  }
  return {
    ...(enabled ? { enabled: true } : {}),
    ...(strategy ? { strategy } : {}),
    ...(address ? { address } : {}),
    ...(hasAddresses ? { addresses } : {}),
    ...(mode === "replace" ? { mode: "replace" as const } : {}),
    ...(customLines && customLines.length > 0 ? { customLines } : {}),
    ...(rawCustomText.trim() ? { rawCustomText } : {}),
  };
}

/**
 * 从订阅源列表提取规则映射。
 * skipApiUrls=true（默认）供 YAML 生成：API 地址需服务端解析后再展开。
 * skipApiUrls=false 供节点列表预览：API 地址也先展开，列表能看到 -CF 副本。
 */
export function cfPreferredSpecsFromSources(
  sources: unknown,
  opts: { skipApiUrls?: boolean } = {},
): Record<string, CfPreferredSpec> | undefined {
  if (!Array.isArray(sources)) return undefined;
  const skipApiUrls = opts.skipApiUrls !== false;
  const out: Record<string, CfPreferredSpec> = {};
  for (const item of sources) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const cfg = normalizeCfPreferredSourceConfig(item.cfPreferred);
    if (!id || !cfg?.enabled) continue;
    const selected = normalizeCfPreferredAddresses(cfg.addresses);
    const mode: CfPreferredMode = cfg.mode === "replace" ? "replace" : "clone";
    if (Array.isArray(cfg.addresses)) {
      if (selected.length === 0) continue;
      out[id] = { address: selected[0], addresses: selected, mode };
      continue;
    }
    if (selected.length > 0) {
      out[id] = { address: selected[0], addresses: selected, mode };
      continue;
    }
    if (!cfg.address) continue;
    if (skipApiUrls && isCfPreferredApiUrl(cfg.address)) continue;
    out[id] = { address: cfg.address, mode };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function cfPreferredStaticBySource(
  config: Record<string, unknown> | { sources?: unknown },
): Record<string, CfPreferredSpec> | undefined {
  return cfPreferredSpecsFromSources((config as Record<string, unknown>).sources, { skipApiUrls: true });
}

function carrierLookup(
  sourcesItem: Record<string, unknown> | undefined,
  pool: CfPreferredPoolConfig | undefined,
): Map<string, CfPreferredCarrier> {
  const map = new Map<string, CfPreferredCarrier>();
  if (pool) {
    for (const entry of pool.entries) map.set(entry.address, entry.carrier);
  }
  const preferred = isRecord(sourcesItem?.cfPreferred) ? sourcesItem.cfPreferred : undefined;
  if (Array.isArray(preferred?.customLines)) {
    for (const line of preferred.customLines) {
      if (!isRecord(line) || typeof line.address !== "string") continue;
      const address = line.address.trim();
      const carrier = asCarrier(line.carrier);
      if (address && carrier) map.set(address, carrier);
    }
  }
  return map;
}

export function attachCfPreferredCarriers(
  sources: unknown,
  specs: Record<string, CfPreferredSpec> | undefined,
  pool: CfPreferredPoolConfig | undefined,
): Record<string, CfPreferredSpec> | undefined {
  if (!specs) return specs;
  const out: Record<string, CfPreferredSpec> = { ...specs };
  const sourceById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(sources)) {
    for (const item of sources) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (id) sourceById.set(id, item);
    }
  }
  for (const [id, spec] of Object.entries(out)) {
    const lookup = carrierLookup(sourceById.get(id), pool);
    const addrs = specAddresses(spec);
    out[id] = {
      ...spec,
      entries: addrs.map((address) => {
        const carrier = lookup.get(address) ?? spec.entries?.find((entry) => entry.address === address)?.carrier;
        return carrier ? { address, carrier } : { address };
      }),
    };
  }
  return out;
}

export function finalizeCfPreferredSpecs(
  sources: unknown,
  existing: Record<string, CfPreferredSpec> | undefined,
  pool: CfPreferredPoolConfig | undefined,
): Record<string, CfPreferredSpec> | undefined {
  return attachCfPreferredCarriers(
    sources,
    mergePlatformCfPreferredPool(sources, existing, pool),
    pool,
  );
}

export function resolveCfPreferredSpecs(
  sources: unknown,
  opts: { skipApiUrls?: boolean; platformPool?: CfPreferredPoolConfig | null } = {},
): Record<string, CfPreferredSpec> | undefined {
  return finalizeCfPreferredSpecs(
    sources,
    cfPreferredSpecsFromSources(sources, { skipApiUrls: opts.skipApiUrls }),
    opts.platformPool ?? undefined,
  );
}

function specForNode(
  node: ParsedNode,
  rulesBySourceId: Record<string, CfPreferredSpec>,
): CfPreferredSpec | undefined {
  for (const sourceId of getNodeSourceIds(node)) {
    const spec = rulesBySourceId[sourceId];
    if (spec) return spec;
  }
  return undefined;
}

/**
 * 按订阅源规则处理套 CF 节点：clone 保留原节点并追加 -CF 副本；replace 直接改入口。
 * 已存在的 CF 副本原样保留，避免重复生成。
 */
export function expandCfPreferredNodes(
  nodes: ParsedNode[],
  rulesBySourceId: Record<string, CfPreferredSpec> | undefined,
): ParsedNode[] {
  if (!rulesBySourceId || Object.keys(rulesBySourceId).length === 0) return nodes;
  const existingNames = new Set(nodes.map((node) => node.name));
  const consumed = new Set<ParsedNode>();
  const expanded = nodes.flatMap((node) => {
    if (getCfPreferredMark(node) === "clone") return [];
    if (getCfPreferredMark(node) === "replace") {
      const spec = specForNode(node, rulesBySourceId);
      if (!spec) return [node];
      const base = cfNameBase(node);
      if (!isManagedCfCloneName(node.name, base)) return [node];
      const entries = specEntries(spec);
      const index = entries.findIndex((entry) => entry.address === node.server);
      if (index < 0) return [node];
      const tag = cloneTag(entries[index].carrier);
      const n = entries.slice(0, index + 1).filter((entry) => cloneTag(entry.carrier) === tag).length;
      const name = groupCloneName(base, tag, n, existingNames, node.name);
      existingNames.add(name);
      return [withCloneName(node, name)];
    }
    const spec = specForNode(node, rulesBySourceId);
    if (!spec || !isCfCdnNode(node)) return [node];
    const entries = specEntries(spec);
    if (entries.length === 0) return [node];
    const seq = new Map<string, number>();
    const base = stripManagedCfSuffix(node.name);
    if (spec.mode === "replace") {
      return entries.map((entry) => {
        const replaced = buildCfReplacedNode(node, entry.address) as unknown as Record<string, unknown>;
        const name = takeGroupCloneName(base, cloneTag(entry.carrier), seq, existingNames);
        replaced.name = name;
        existingNames.add(name);
        return replaced as unknown as ParsedNode;
      });
    }
    const of = originKey(node);
    const result: ParsedNode[] = [node];
    entries.forEach((entry) => {
      const existing = nodes.find(
        (candidate) =>
          getCfPreferredMark(candidate) === "clone" &&
          !consumed.has(candidate) &&
          candidate.server === entry.address &&
          (cloneTargetKey(candidate) === of || cloneTargetKey(candidate) === node.name),
      );
      if (existing) {
        consumed.add(existing);
        if (isManagedCfCloneName(existing.name, of) || isManagedCfCloneName(existing.name, base)) {
          const name = takeGroupCloneName(base, cloneTag(entry.carrier), seq, existingNames, existing.name);
          existingNames.add(name);
          result.push(withCloneName(existing, name));
        } else {
          result.push(existing);
        }
        return;
      }
      const name = takeGroupCloneName(base, cloneTag(entry.carrier), seq, existingNames);
      const clone = buildCfPreferredClone(node, entry.address, name);
      existingNames.add(name);
      result.push(clone);
    });
    return result;
  });
  const orphans = nodes.filter((node) => getCfPreferredMark(node) === "clone" && !consumed.has(node));
  return orphans.length === 0 ? expanded : [...expanded, ...orphans];
}

/** 把 CF 副本写进节点列表：关掉的源丢掉副本，地址变了就改入口，缺的补上。 */
export function syncCfPreferredNodes(
  nodes: ParsedNode[],
  rulesBySourceId: Record<string, CfPreferredSpec> | undefined,
): ParsedNode[] {
  const rules = rulesBySourceId ?? {};
  const usedByOf = new Map<string, Set<string>>();
  const kept: ParsedNode[] = [];
  for (const node of nodes) {
    if (getCfPreferredMark(node) !== "clone") {
      kept.push(node);
      continue;
    }
    const spec = specForNode(node, rules);
    if (!spec || spec.mode !== "clone") continue;
    const addrs = specAddresses(spec);
    if (addrs.length === 0) continue;
    const of = cloneTargetKey(node);
    const used = usedByOf.get(of) ?? new Set<string>();
    const server = node.server ?? "";
    if (server && addrs.includes(server) && !used.has(server)) {
      kept.push(node);
      used.add(server);
    } else {
      const nextAddr = addrs.find((addr) => !used.has(addr));
      if (nextAddr) {
        kept.push(withCloneAddress(node, nextAddr));
        used.add(nextAddr);
      }
    }
    usedByOf.set(of, used);
  }
  const next = expandCfPreferredNodes(kept, Object.keys(rules).length > 0 ? rules : undefined);
  if (next.length === nodes.length && next.every((node, index) => node === nodes[index])) return nodes;
  return next;
}

export function applyCfPreferredToNodes(
  nodes: ParsedNode[],
  sources: unknown,
  platformPool?: CfPreferredPoolConfig | null,
): ParsedNode[] {
  // API 地址要等服务端解析，不能把 URL 写进节点 server
  return syncCfPreferredNodes(
    nodes,
    resolveCfPreferredSpecs(sources, { skipApiUrls: true, platformPool }),
  );
}
