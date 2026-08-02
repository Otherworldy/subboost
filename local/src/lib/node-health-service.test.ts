import { beforeEach, describe, expect, it, vi } from "vitest";
import { runNodeHealthChecks } from "./node-health-service";

const mocks = vi.hoisted(() => ({
  runMihomoHealthCheck: vi.fn(),
}));

vi.mock("./mihomo-health-check", () => ({
  runMihomoHealthCheck: mocks.runMihomoHealthCheck,
}));

const sources = [
  { id: "s1", type: "url", content: "https://a.example/sub", healthCheck: { enabled: true, maxDelayMs: 1500 } },
  { id: "s2", type: "yaml", content: "proxies: []" },
  { id: "provider", type: "url", content: "https://p.example/sub", useProxyProviders: true },
];

const nodes = [
  { name: "A", type: "vmess", server: "a.example.com", port: 443, uuid: "u", _sourceIds: ["s1"] },
  { name: "B", type: "ss", server: "b.example.com", port: 443, cipher: "aes", password: "p", _sourceIds: ["s1", "s2"] },
  { name: "C", type: "direct", _sourceIds: ["s2"] },
] as any[];

function okResult(names: string[], delay = 100) {
  const results = new Map<string, { status: "ok"; delayMs: number; checkedAt: string }>();
  for (const name of names) results.set(name, { status: "ok", delayMs: delay, checkedAt: "t" });
  return results;
}

describe("runNodeHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runMihomoHealthCheck.mockImplementation(async ({ nodes: input }: { nodes: Array<{ name: string }> }) =>
      okResult(input.map((item) => item.name))
    );
  });

  it("tests every non-provider source for the all scope and merges results", async () => {
    const result = await runNodeHealthChecks({ nodes, sources, scope: { kind: "all" } });

    expect(mocks.runMihomoHealthCheck).toHaveBeenCalledTimes(2);
    expect(mocks.runMihomoHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ enabled: true, maxDelayMs: 1500 }),
      })
    );
    expect(mocks.runMihomoHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ url: "https://www.google.com/", maxDelayMs: 5000, concurrency: 20 }),
      })
    );
    expect(result.summary).toEqual({ tested: 3, ok: 3, fail: 0, unsupported: 0 });
    const byName = new Map(result.nodes.map((item) => [item.name, item.health]));
    expect(byName.get("A")).toMatchObject({ s1: { status: "ok" } });
    expect(byName.get("B")).toMatchObject({ s1: { status: "ok" }, s2: { status: "ok" } });
    expect(byName.get("C")).toMatchObject({ s2: { status: "ok" } });
  });

  it("tests only the requested source for the source scope", async () => {
    const result = await runNodeHealthChecks({ nodes, sources, scope: { kind: "source", sourceId: "s2" } });

    expect(mocks.runMihomoHealthCheck).toHaveBeenCalledTimes(1);
    const inputNodes = mocks.runMihomoHealthCheck.mock.calls[0][0].nodes.map((item: { name: string }) => item.name);
    expect(inputNodes.sort()).toEqual(["B", "C"]);
    expect(result.nodes.map((item) => item.name).sort()).toEqual(["B", "C"]);
  });

  it("rejects unknown sources and nodes", async () => {
    await expect(
      runNodeHealthChecks({ nodes, sources, scope: { kind: "source", sourceId: "ghost" } })
    ).rejects.toThrow("未知的导入源");
    await expect(
      runNodeHealthChecks({ nodes, sources, scope: { kind: "node", nodeName: "ghost" } })
    ).rejects.toThrow("未知的节点");
  });

  it("tests every source owning the node for the node scope", async () => {
    const result = await runNodeHealthChecks({ nodes, sources, scope: { kind: "node", nodeName: "B" } });

    expect(mocks.runMihomoHealthCheck).toHaveBeenCalledTimes(2);
    const byName = new Map(result.nodes.map((item) => [item.name, item.health]));
    expect(byName.get("B")).toMatchObject({ s1: { status: "ok" }, s2: { status: "ok" } });
    expect(result.summary).toEqual({ tested: 3, ok: 3, fail: 0, unsupported: 0 });
  });

  it("rejects nodes without any known source", async () => {
    const orphan = { name: "Orphan", type: "ss", server: "x", port: 1, cipher: "aes", password: "p" };
    await expect(
      runNodeHealthChecks({ nodes: [orphan], sources, scope: { kind: "node", nodeName: "Orphan" } })
    ).rejects.toThrow("该节点不属于任何导入源，无需测活");
  });

  it("skips proxy-provider sources and reports fail/unsupported in summaries", async () => {
    mocks.runMihomoHealthCheck.mockImplementation(async ({ nodes: input }: { nodes: Array<{ name: string }> }) => {
      const results = new Map<string, { status: "ok" | "fail"; delayMs?: number; checkedAt: string }>();
      for (const item of input) {
        results.set(item.name, item.name === "A" ? { status: "fail", checkedAt: "t" } : { status: "ok", delayMs: 5, checkedAt: "t" });
      }
      return results;
    });

    const result = await runNodeHealthChecks({ nodes, sources, scope: { kind: "all" } });

    expect(mocks.runMihomoHealthCheck).toHaveBeenCalledTimes(2);
    expect(result.summary).toEqual({ tested: 3, ok: 2, fail: 1, unsupported: 0 });
  });
});
