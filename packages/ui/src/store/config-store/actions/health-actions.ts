import type { ParsedNode } from "@subboost/core/types/node";
import {
  HEALTH_RESULTS_KEY,
  getNodeHealthResults,
  type NodeHealthResult,
} from "@subboost/core/subscription/node-health";
import { getActiveProductApiAdapter } from "@subboost/ui/product/api-adapter";
import type { ConfigActions, HealthCheckScope, HealthRunOutcome } from "../definitions";
import type { GetState, SetAndGenerateConfig, SetState } from "../store-types";

type HealthActions = Pick<ConfigActions, "applyHealthResults" | "runHealthCheck">;

type HealthIncoming = Array<{ name: string; health: Record<string, NodeHealthResult> }>;

function mergeHealthIntoState(
  setAndGenerateConfig: SetAndGenerateConfig,
  incoming: HealthIncoming
): void {
  const byName = new Map(incoming.map((item) => [item.name, item]));
  setAndGenerateConfig((state) => {
    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      const item = byName.get(node.name);
      if (!item || Object.keys(item.health).length === 0) return node;
      const record = node as unknown as Record<string, unknown>;
      changed = true;
      return { ...record, [HEALTH_RESULTS_KEY]: item.health } as unknown as ParsedNode;
    });
    return changed ? { nodes: nextNodes } : state;
  });
}

// 流式回显：单条 (节点, 来源) 结果增量合并，不覆盖其他来源的结果
function mergeSingleResult(
  setAndGenerateConfig: SetAndGenerateConfig,
  nodeName: string,
  sourceId: string,
  result: NodeHealthResult
): void {
  setAndGenerateConfig((state) => {
    const index = state.nodes.findIndex((node) => node.name === nodeName);
    if (index < 0) return state;
    const record = state.nodes[index] as unknown as Record<string, unknown>;
    const existing = (record[HEALTH_RESULTS_KEY] ?? {}) as Record<string, NodeHealthResult>;
    const nextNodes = state.nodes.slice();
    nextNodes[index] = {
      ...record,
      [HEALTH_RESULTS_KEY]: { ...existing, [sourceId]: result },
    } as unknown as ParsedNode;
    return { nodes: nextNodes };
  });
}

export function createHealthActions(
  set: SetState,
  get: GetState,
  setAndGenerateConfig: SetAndGenerateConfig
): HealthActions {
  // 递增序号：只允许最新一次测活响应写回，防止过期响应覆盖已变化节点
  let latestRunId = 0;

  return {
    // 把服务端保存/测活返回的节点结果合并回当前状态（按节点名匹配，仅覆盖 _health）
    applyHealthResults: (nodes: ParsedNode[]) => {
      mergeHealthIntoState(
        setAndGenerateConfig,
        nodes.map((node) => ({ name: node.name, health: getNodeHealthResults(node) }))
      );
    },

    // 立即测活：不受自动开关限制，范围 all / source / node
    runHealthCheck: async (scope: HealthCheckScope): Promise<HealthRunOutcome> => {
      const api = getActiveProductApiAdapter().healthCheck;
      if (!api) {
        return { ok: false, error: "当前应用未配置测活服务" };
      }

      const state = get();
      const runId = ++latestRunId;
      try {
        const response = await api.runHealthCheck(
          {
            scope,
            nodes: state.nodes,
            sources: state.sources,
          },
          (name, sourceId, result) => {
            if (runId !== latestRunId) return; // 已被更新的测活请求取代，丢弃过期回显
            mergeSingleResult(setAndGenerateConfig, name, sourceId, result);
          }
        );
        if (runId !== latestRunId) {
          // 已被更新的测活请求取代，丢弃过期结果
          return { ok: false, error: null };
        }
        return { ok: true, summary: response.summary };
      } catch (error) {
        if (runId !== latestRunId) return { ok: false, error: null };
        return { ok: false, error: error instanceof Error ? error.message : "测活失败" };
      }
    },
  };
}
