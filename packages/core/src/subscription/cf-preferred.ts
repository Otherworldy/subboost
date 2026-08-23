/**
 * CF 优选节点生成
 *
 * 套 Cloudflare CDN 的节点（vless/vmess/trojan + WS/gRPC 等 + TLS + CF 端口）具有
 * "入口与身份分离"的特性：任意 CF 边缘 IP 都能通过 SNI/Host 路由到原服务器。
 * 按订阅源为命中节点生成优选副本（clone）或直接替换入口（replace）。
 */
import type { CfPreferredMode, CfPreferredSourceConfig } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";

/** Cloudflare 支持的 HTTPS 端口；不在白名单的端口不可能是 CF 入口 */
export const CF_TLS_PORTS: ReadonlySet<number> = new Set([443, 2053, 2083, 2087, 2096, 8443]);

export type CfPreferredSpec = { address: string; mode: CfPreferredMode };

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

export function getCfPreferredMark(node: ParsedNode): CfPreferredMode | undefined {
  const mark = (node as unknown as Record<string, unknown>)[CF_PREFERRED_MARK_KEY];
  return mark === "clone" || mark === "replace" ? mark : undefined;
}

/** 为单个套 CF 节点构建优选副本（原节点名加 -CF 后缀） */
export function buildCfPreferredClone(node: ParsedNode, address: string): ParsedNode {
  const clone = rewriteCfServer(node, address);
  clone.name = `${node.name}-CF`;
  clone[CF_PREFERRED_MARK_KEY] = "clone";
  return clone as unknown as ParsedNode;
}

/** 直接替换原节点入口，节点名不变 */
export function buildCfReplacedNode(node: ParsedNode, address: string): ParsedNode {
  const replaced = rewriteCfServer(node, address);
  replaced[CF_PREFERRED_MARK_KEY] = "replace";
  return replaced as unknown as ParsedNode;
}

export function normalizeCfPreferredSourceConfig(value: unknown): CfPreferredSourceConfig | undefined {
  if (!isRecord(value)) return undefined;
  const address = typeof value.address === "string" ? value.address.trim() : "";
  const mode: CfPreferredMode = value.mode === "replace" ? "replace" : "clone";
  const enabled = value.enabled === true;
  if (!enabled && !address) return undefined;
  return {
    ...(enabled ? { enabled: true } : {}),
    ...(address ? { address } : {}),
    ...(mode === "replace" ? { mode: "replace" as const } : {}),
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
    if (!id || !cfg?.enabled || !cfg.address) continue;
    if (skipApiUrls && isCfPreferredApiUrl(cfg.address)) continue;
    out[id] = { address: cfg.address, mode: cfg.mode === "replace" ? "replace" : "clone" };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function cfPreferredStaticBySource(
  config: Record<string, unknown> | { sources?: unknown },
): Record<string, CfPreferredSpec> | undefined {
  return cfPreferredSpecsFromSources((config as Record<string, unknown>).sources, { skipApiUrls: true });
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
 * 未命中规则或不符合 CF CDN 形态的节点原样保留。
 */
export function expandCfPreferredNodes(
  nodes: ParsedNode[],
  rulesBySourceId: Record<string, CfPreferredSpec> | undefined,
): ParsedNode[] {
  if (!rulesBySourceId || Object.keys(rulesBySourceId).length === 0) return nodes;
  return nodes.flatMap((node) => {
    const spec = specForNode(node, rulesBySourceId);
    if (!spec || !isCfCdnNode(node)) return [node];
    if (spec.mode === "replace") return [buildCfReplacedNode(node, spec.address)];
    return [node, buildCfPreferredClone(node, spec.address)];
  });
}
