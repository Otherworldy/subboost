/**
 * CF 优选「测速与选优」：把候选 IP 写进该源可套 CF 的节点，再用 mihomo 测真实延迟。
 * 不是 TCP ping。订阅刷新时的 API 自动跟随仍走 TCPing（见 server-core resolveCfPreferredAddress）。
 */
import {
  buildCfReplacedNode,
  isCfCdnNode,
  isCfPreferredApiUrl,
  type CfPreferredSpec,
} from "@subboost/core/subscription/cf-preferred";
import {
  resolveSourceHealthCheck,
  type NodeHealthResult,
  type SourceHealthCheckConfig,
} from "@subboost/core/subscription/node-health";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import type { ParsedNode } from "@subboost/core/types/node";
import { fetchCfPreferredCandidates } from "@subboost/server-core/cf-preferred";
import { runMihomoHealthCheck } from "./mihomo-health-check";

// ponytail: 全量节点×IP 会顶满 mihomo 3min 上限；入口/节点再多时截前 16×20
const MAX_IPS = 16;
const MAX_NODES = 20;

export type CfPreferredNodeProbe = {
  name: string;
  status: NodeHealthResult["status"];
  delayMs?: number;
};

export type CfPreferredPreviewCandidate = {
  ip: string;
  ms: number | null;
  ok: number;
  fail: number;
  unsupported: number;
  nodes: CfPreferredNodeProbe[];
};

export type CfPreferredPreviewResult = {
  candidates: CfPreferredPreviewCandidate[];
  totalResolved: number;
  message?: string;
};

export type PreviewCfPreferredByNodesParams = {
  address: string;
  sourceId: string;
  nodes: unknown;
  healthCheck?: SourceHealthCheckConfig;
  mode?: CfPreferredSpec["mode"];
};

export type PreviewCfPreferredByNodesDeps = {
  fetchCandidates?: (address: string) => Promise<string[]>;
  runHealthCheck?: typeof runMihomoHealthCheck;
};

function asNodes(raw: unknown): ParsedNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ParsedNode => Boolean(item) && typeof item === "object");
}

function displayName(node: ParsedNode, mode: CfPreferredSpec["mode"]): string {
  return mode === "replace" ? node.name : `${node.name}-CF`;
}

export async function previewCfPreferredByNodes(
  params: PreviewCfPreferredByNodesParams,
  deps: PreviewCfPreferredByNodesDeps = {},
): Promise<CfPreferredPreviewResult> {
  const address = params.address.trim();
  const sourceId = params.sourceId.trim();
  const mode: CfPreferredSpec["mode"] = params.mode === "replace" ? "replace" : "clone";
  const fetchCandidates = deps.fetchCandidates ?? fetchCfPreferredCandidates;
  const runHealthCheck = deps.runHealthCheck ?? runMihomoHealthCheck;

  const ips = address ? await fetchCandidates(address) : [];
  if (ips.length === 0) {
    return {
      candidates: [],
      totalResolved: 0,
      message: isCfPreferredApiUrl(address)
        ? "已访问该地址但未能提取到 IP：请确认它直接返回优选 IP 列表（如 cf.090227.xyz/ct），而非网页页面。"
        : "无法解析该域名或地址无效，请检查拼写或稍后重试。",
    };
  }

  const eligible = asNodes(params.nodes)
    .filter((node) => getNodeSourceIds(node).includes(sourceId) && isCfCdnNode(node))
    .slice(0, MAX_NODES);
  if (eligible.length === 0) {
    return {
      candidates: [],
      totalResolved: ips.length,
      message: "该源没有可套 CF 的节点，无法按优选节点测速。请先导入 VLESS / VMess / Trojan（WS/gRPC + TLS）节点。",
    };
  }

  const selectedIps = ips.slice(0, MAX_IPS);
  const probes: ParsedNode[] = [];
  const meta: Array<{ probeName: string; ip: string; name: string }> = [];
  let index = 0;
  for (const ip of selectedIps) {
    for (const node of eligible) {
      const probeName = `cf-${index}`;
      index += 1;
      probes.push({ ...buildCfReplacedNode(node, ip), name: probeName } as ParsedNode);
      meta.push({ probeName, ip, name: displayName(node, mode) });
    }
  }

  const results = await runHealthCheck(
    { nodes: probes, config: resolveSourceHealthCheck({ healthCheck: params.healthCheck }) },
    "interactive",
  );

  const byIp = new Map<string, CfPreferredPreviewCandidate>();
  for (const ip of selectedIps) {
    byIp.set(ip, { ip, ms: null, ok: 0, fail: 0, unsupported: 0, nodes: [] });
  }
  for (const item of meta) {
    const result = results.get(item.probeName) ?? { status: "fail" as const, checkedAt: "" };
    const row = byIp.get(item.ip);
    if (!row) continue;
    row.nodes.push({
      name: item.name,
      status: result.status,
      ...(typeof result.delayMs === "number" ? { delayMs: result.delayMs } : {}),
    });
    if (result.status === "ok") {
      row.ok += 1;
      if (typeof result.delayMs === "number" && (row.ms === null || result.delayMs < row.ms)) {
        row.ms = result.delayMs;
      }
    } else if (result.status === "unsupported") {
      row.unsupported += 1;
    } else {
      row.fail += 1;
    }
  }

  return {
    candidates: [...byIp.values()].sort(
      (a, b) => (a.ms ?? Number.POSITIVE_INFINITY) - (b.ms ?? Number.POSITIVE_INFINITY),
    ),
    totalResolved: ips.length,
  };
}
