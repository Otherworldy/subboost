import { describe, expect, it, vi } from "vitest";
import { previewCfPreferredByNodes } from "./cf-preferred-preview";
import type { ParsedNode } from "@subboost/core/types/node";

function cfNode(name: string, sourceId = "src-a"): ParsedNode {
  return {
    name,
    type: "vless",
    server: "hk.example.com",
    port: 443,
    uuid: "uuid-1",
    tls: true,
    network: "ws",
    "ws-opts": { path: "/ws" },
    _sourceIds: [sourceId],
  } as unknown as ParsedNode;
}

describe("previewCfPreferredByNodes", () => {
  it("解析不到 IP 时返回说明，不测活", async () => {
    const runHealthCheck = vi.fn();
    const result = await previewCfPreferredByNodes(
      { address: "https://cf.example.com/ct", sourceId: "src-a", nodes: [cfNode("日本")] },
      { fetchCandidates: async () => [], runHealthCheck },
    );
    expect(result.candidates).toEqual([]);
    expect(result.message).toContain("未能提取到 IP");
    expect(runHealthCheck).not.toHaveBeenCalled();
  });

  it("没有可套 CF 的节点时返回说明，不测活", async () => {
    const runHealthCheck = vi.fn();
    const ss = {
      name: "ss",
      type: "ss",
      server: "a.com",
      port: 443,
      cipher: "aes-128-gcm",
      password: "p",
      _sourceIds: ["src-a"],
    };
    const result = await previewCfPreferredByNodes(
      { address: "1.1.1.1", sourceId: "src-a", nodes: [ss, cfNode("日本", "other")] },
      { fetchCandidates: async () => ["1.1.1.1"], runHealthCheck },
    );
    expect(result.totalResolved).toBe(1);
    expect(result.candidates).toEqual([]);
    expect(result.message).toContain("没有可套 CF 的节点");
    expect(runHealthCheck).not.toHaveBeenCalled();
  });

  it("按优选后的节点实测延迟排序，而不是入口 IP 顺序", async () => {
    const runHealthCheck = vi.fn(async ({ nodes }: { nodes: Array<{ name: string; server?: string }> }) => {
      const map = new Map();
      for (const node of nodes) {
        map.set(node.name, {
          status: node.server === "9.9.9.9" ? "ok" : "fail",
          delayMs: node.server === "9.9.9.9" ? 80 : undefined,
          checkedAt: "t",
        });
      }
      return map;
    });

    const result = await previewCfPreferredByNodes(
      {
        address: "https://cf.example.com/ct",
        sourceId: "src-a",
        nodes: [cfNode("日本"), cfNode("香港")],
        mode: "clone",
      },
      { fetchCandidates: async () => ["1.1.1.1", "9.9.9.9"], runHealthCheck },
    );

    expect(runHealthCheck).toHaveBeenCalledTimes(1);
    const probed = runHealthCheck.mock.calls[0][0].nodes as Array<{ name: string; server: string }>;
    expect(probed).toHaveLength(4);
    expect(new Set(probed.map((n) => n.server))).toEqual(new Set(["1.1.1.1", "9.9.9.9"]));
    expect(probed.every((n) => n.server !== "hk.example.com")).toBe(true);

    expect(result.candidates.map((c) => c.ip)).toEqual(["9.9.9.9", "1.1.1.1"]);
    expect(result.candidates[0]).toMatchObject({
      ip: "9.9.9.9",
      ms: 80,
      ok: 2,
      fail: 0,
    });
    expect(result.candidates[0].nodes.map((n) => n.name)).toEqual(["日本-CF", "香港-CF"]);
    expect(result.candidates[1]).toMatchObject({ ip: "1.1.1.1", ms: null, ok: 0, fail: 2 });
  });

  it("replace 模式结果用原节点名；取该入口下最快通的节点延迟", async () => {
    const runHealthCheck = vi.fn(async ({ nodes }: { nodes: Array<{ name: string }> }) => {
      const map = new Map();
      map.set(nodes[0].name, { status: "ok", delayMs: 200, checkedAt: "t" });
      map.set(nodes[1].name, { status: "ok", delayMs: 50, checkedAt: "t" });
      return map;
    });
    const result = await previewCfPreferredByNodes(
      {
        address: "1.2.3.4",
        sourceId: "src-a",
        nodes: [cfNode("日本"), cfNode("香港")],
        mode: "replace",
      },
      { fetchCandidates: async () => ["1.2.3.4"], runHealthCheck },
    );
    expect(result.candidates).toEqual([
      {
        ip: "1.2.3.4",
        ms: 50,
        ok: 2,
        fail: 0,
        unsupported: 0,
        nodes: [
          { name: "日本", status: "ok", delayMs: 200 },
          { name: "香港", status: "ok", delayMs: 50 },
        ],
      },
    ]);
  });
});
