import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { HEALTH_RESULTS_KEY } from "@subboost/core/subscription/node-health";
import { initialState } from "../definitions";
import { createHealthActions } from "./health-actions";

const mocks = vi.hoisted(() => ({
  adapter: { healthCheck: { runHealthCheck: vi.fn() } } as {
    healthCheck: { runHealthCheck: ReturnType<typeof vi.fn> } | undefined;
  },
}));

vi.mock("@subboost/ui/product/api-adapter", () => ({
  getActiveProductApiAdapter: () => mocks.adapter,
}));

function createHarness(overrides: Record<string, unknown> = {}) {
  let state = {
    ...structuredClone(initialState),
    ...overrides,
  } as Record<string, any>;
  const applyPatch = (patch: any) => {
    if (patch && patch !== state) state = { ...state, ...patch };
  };
  const set = (partial: any) => applyPatch(typeof partial === "function" ? partial(state) : partial);
  const setAndGenerateConfig = (updater: any) => applyPatch(updater(state));
  const actions = createHealthActions(set, () => state, setAndGenerateConfig);
  return { actions, getState: () => state };
}

function node(name: string, extra: Record<string, unknown> = {}): ParsedNode {
  return { name, type: "ss", server: "example.com", port: 443, cipher: "aes", password: "p", ...extra } as ParsedNode;
}

const sources = [
  { id: "s1", type: "url", content: "https://a.example/sub", healthCheck: { enabled: true } },
  { id: "s2", type: "yaml", content: "proxies: []" },
];

describe("createHealthActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.healthCheck = { runHealthCheck: vi.fn() };
  });

  it("merges returned health results into current nodes by name", () => {
    const { actions, getState } = createHarness({
      nodes: [node("A", { _sourceIds: ["s1"] }), node("B", { _sourceIds: ["s2"] })],
      sources,
    });

    actions.applyHealthResults([
      { ...node("A"), [HEALTH_RESULTS_KEY]: { s1: { status: "ok", delayMs: 50, checkedAt: "t" } } },
    ] as unknown as ParsedNode[]);

    const a = getState().nodes.find((item: ParsedNode) => item.name === "A");
    expect((a as any)[HEALTH_RESULTS_KEY]).toEqual({ s1: { status: "ok", delayMs: 50, checkedAt: "t" } });
    expect(getState().nodes.find((item: ParsedNode) => item.name === "B")).not.toHaveProperty(HEALTH_RESULTS_KEY);
  });

  it("calls the api adapter with the current state and streams results into the store", async () => {
    const { actions, getState } = createHarness({
      nodes: [node("A", { _sourceIds: ["s1"] })],
      sources,
    });
    mocks.adapter.healthCheck!.runHealthCheck.mockImplementation(async (_request, onResult) => {
      onResult?.("A", "s1", { status: "ok", delayMs: 10, checkedAt: "t" });
      return { nodes: [], summary: { tested: 1, ok: 1, fail: 0, unsupported: 0 } };
    });

    const outcome = await actions.runHealthCheck({ kind: "source", sourceId: "s1" });

    expect(outcome).toEqual({ ok: true, summary: { tested: 1, ok: 1, fail: 0, unsupported: 0 } });
    expect(mocks.adapter.healthCheck!.runHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "source", sourceId: "s1" },
        nodes: [expect.objectContaining({ name: "A" })],
        sources,
      }),
      expect.any(Function)
    );
    expect((getState().nodes[0] as any)[HEALTH_RESULTS_KEY]).toEqual({
      s1: { status: "ok", delayMs: 10, checkedAt: "t" },
    });
  });

  it("discards stale responses so newer runs win", async () => {
    const { actions, getState } = createHarness({
      nodes: [node("A", { _sourceIds: ["s1"] })],
      sources,
    });
    let resolveFirst!: (value: unknown) => void;
    let firstOnResult!: (name: string, sourceId: string, result: unknown) => void;
    mocks.adapter.healthCheck!.runHealthCheck
      .mockImplementationOnce((_request, onResult) => {
        firstOnResult = onResult;
        return new Promise((resolve) => { resolveFirst = resolve; });
      })
      .mockImplementationOnce(async (_request, onResult) => {
        onResult?.("A", "s1", { status: "ok", delayMs: 9, checkedAt: "newer" });
        return { nodes: [], summary: { tested: 1, ok: 1, fail: 0, unsupported: 0 } };
      });

    const first = actions.runHealthCheck({ kind: "all" });
    const second = await actions.runHealthCheck({ kind: "all" });
    // 过期请求的回显到达：runId 已过期，不得写入状态
    firstOnResult?.("A", "s1", { status: "ok", delayMs: 999, checkedAt: "stale" });
    resolveFirst({
      nodes: [{ name: "A", health: { s1: { status: "ok", delayMs: 999, checkedAt: "stale" } } }],
      summary: { tested: 1, ok: 1, fail: 0, unsupported: 0 },
    });
    const firstOutcome = await first;

    expect(second).toMatchObject({ ok: true });
    expect(firstOutcome).toMatchObject({ ok: false, error: null });
    expect((getState().nodes[0] as any)[HEALTH_RESULTS_KEY]).toEqual({
      s1: { status: "ok", delayMs: 9, checkedAt: "newer" },
    });
  });

  it("reports missing api adapters and adapter errors", async () => {
    mocks.adapter.healthCheck = undefined;
    const { actions } = createHarness({ nodes: [node("A")], sources });
    await expect(actions.runHealthCheck({ kind: "all" })).resolves.toEqual({
      ok: false,
      error: "当前应用未配置测活服务",
    });

    mocks.adapter.healthCheck = {
      runHealthCheck: vi.fn().mockRejectedValue(new Error("未知的导入源")),
    };
    await expect(actions.runHealthCheck({ kind: "all" })).resolves.toEqual({
      ok: false,
      error: "未知的导入源",
    });
  });
});
