import { describe, expect, it } from "vitest";
import {
  applyCfPreferredToNodes,
  buildCfPreferredClone,
  CF_PREFERRED_MARK_KEY,
  CF_PREFERRED_OF_KEY,
  cfPreferredSpecsFromSources,
  cfPreferredStaticBySource,
  expandCfPreferredNodes,
  getCfPreferredMark,
  getCfPreferredOf,
  isCfCdnNode,
  isCfPreferredApiUrl,
  normalizeCfPreferredSourceConfig,
  syncCfPreferredNodes,
} from "./cf-preferred";
import type { ParsedNode } from "../types/node";

function vlessWsTls(overrides: Record<string, unknown> = {}): ParsedNode {
  return {
    name: "香港 IEPL-01",
    type: "vless",
    server: "hk.example.com",
    port: 443,
    uuid: "uuid-1",
    tls: true,
    network: "ws",
    "ws-opts": { path: "/ws" },
    _sourceIds: ["src-a"],
    ...overrides,
  } as unknown as ParsedNode;
}

describe("isCfPreferredApiUrl", () => {
  it("识别 http(s) URL，其余视为静态地址", () => {
    expect(isCfPreferredApiUrl("https://cf.example.com/ct?ips=6")).toBe(true);
    expect(isCfPreferredApiUrl("http://cf.example.com/cu")).toBe(true);
    expect(isCfPreferredApiUrl(" cf.090227.xyz ")).toBe(false);
    expect(isCfPreferredApiUrl("104.16.1.1")).toBe(false);
    expect(isCfPreferredApiUrl("")).toBe(false);
  });
});

describe("isCfCdnNode", () => {
  it("vless+ws+tls+443 且 server 为域名 → 命中", () => {
    expect(isCfCdnNode(vlessWsTls())).toBe(true);
  });

  it("显式 sni/servername 时纯 IP server 也命中", () => {
    expect(isCfCdnNode(vlessWsTls({ server: "104.16.1.1", servername: "hk.example.com" }))).toBe(true);
  });

  it("REALITY / 非 TLS / 非 CF 端口 / 纯 IP 无身份 / tcp 网络 → 不命中", () => {
    expect(isCfCdnNode(vlessWsTls({ "reality-opts": { "public-key": "k" } }))).toBe(false);
    expect(isCfCdnNode(vlessWsTls({ tls: false }))).toBe(false);
    expect(isCfCdnNode(vlessWsTls({ port: 8388 }))).toBe(false);
    expect(isCfCdnNode(vlessWsTls({ server: "104.16.1.1", servername: undefined, sni: undefined }))).toBe(false);
    expect(isCfCdnNode(vlessWsTls({ network: "tcp" }))).toBe(false);
  });

  it("trojan 隐含 TLS；ss 节点不命中", () => {
    const trojan = { name: "t", type: "trojan", server: "a.com", port: 443, password: "p", network: "grpc" } as unknown as ParsedNode;
    const ss = { name: "s", type: "ss", server: "a.com", port: 443, cipher: "aes-128-gcm", password: "p" } as unknown as ParsedNode;
    expect(isCfCdnNode(trojan)).toBe(true);
    expect(isCfCdnNode(ss)).toBe(false);
  });
});

describe("normalizeCfPreferredSourceConfig / cfPreferredStaticBySource", () => {
  it("规范化源配置；未开启或 API URL 不进入静态映射", () => {
    expect(normalizeCfPreferredSourceConfig(null)).toBeUndefined();
    expect(normalizeCfPreferredSourceConfig({ enabled: false })).toBeUndefined();
    expect(normalizeCfPreferredSourceConfig({ enabled: true, address: " cf.090227.xyz ", mode: "replace" })).toEqual({
      enabled: true,
      address: "cf.090227.xyz",
      mode: "replace",
    });
    expect(
      normalizeCfPreferredSourceConfig({
        enabled: true,
        address: "cf.090227.xyz",
        addresses: [" 1.1.1.1 ", "1.1.1.1", "https://x", "2.2.2.2"],
      }),
    ).toEqual({
      enabled: true,
      address: "cf.090227.xyz",
      addresses: ["1.1.1.1", "2.2.2.2"],
    });

    const sources = [
      { id: "src-a", cfPreferred: { enabled: true, address: "cf.090227.xyz" } },
      { id: "src-b", cfPreferred: { enabled: true, address: "https://cf.example.com/ct", mode: "replace" } },
      { id: "src-c", cfPreferred: { enabled: false, address: "1.2.3.4" } },
      { id: "src-d" },
    ];
    expect(cfPreferredStaticBySource({ sources })).toEqual({
      "src-a": { address: "cf.090227.xyz", mode: "clone" },
    });
    expect(cfPreferredSpecsFromSources(sources, { skipApiUrls: false })).toEqual({
      "src-a": { address: "cf.090227.xyz", mode: "clone" },
      "src-b": { address: "https://cf.example.com/ct", mode: "replace" },
    });
  });
});

describe("expandCfPreferredNodes", () => {
  it("clone：命中源生成副本，原节点保留在前", () => {
    const out = expandCfPreferredNodes([vlessWsTls()], { "src-a": { address: "cf.090227.xyz", mode: "clone" } });
    expect(out).toHaveLength(2);
    expect(out[0].server).toBe("hk.example.com");
    const clone = out[1] as Record<string, unknown>;
    expect(clone.name).toBe("香港 IEPL-01-CF");
    expect(clone.server).toBe("cf.090227.xyz");
    expect(clone.servername).toBe("hk.example.com");
    expect(clone[CF_PREFERRED_MARK_KEY]).toBe("clone");
    expect(getCfPreferredMark(out[0])).toBeUndefined();
    expect(getCfPreferredMark(out[1])).toBe("clone");
  });

  it("replace：直接改入口，不增加节点、名字不变", () => {
    const out = expandCfPreferredNodes([vlessWsTls()], { "src-a": { address: "1.2.3.4", mode: "replace" } });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("香港 IEPL-01");
    expect(out[0].server).toBe("1.2.3.4");
    expect((out[0] as unknown as Record<string, unknown>).servername).toBe("hk.example.com");
    expect(getCfPreferredMark(out[0])).toBe("replace");
  });

  it("未绑定该源 / 非 CF 节点 / 空规则 → 原样", () => {
    const node = vlessWsTls();
    expect(expandCfPreferredNodes([node], { "src-other": { address: "1.2.3.4", mode: "clone" } })).toEqual([node]);
    const ss = { name: "s", type: "ss", server: "a.com", port: 443, cipher: "x", password: "p", _sourceIds: ["src-a"] } as unknown as ParsedNode;
    expect(expandCfPreferredNodes([ss], { "src-a": { address: "1.2.3.4", mode: "clone" } })).toHaveLength(1);
    expect(expandCfPreferredNodes([node], undefined)).toHaveLength(1);
    expect(expandCfPreferredNodes([node], {})).toHaveLength(1);
  });

  it("WS Host 缺失时补上原域名；已有 Host 则不动", () => {
    const clone = expandCfPreferredNodes([vlessWsTls()], { "src-a": { address: "1.2.3.4", mode: "clone" } })[1] as Record<string, unknown>;
    const ws = clone["ws-opts"] as { headers?: Record<string, string> };
    expect(ws.headers?.Host).toBe("hk.example.com");

    const withHost = vlessWsTls({ "ws-opts": { path: "/ws", headers: { Host: "custom.example.com" } } });
    const clone2 = expandCfPreferredNodes([withHost], { "src-a": { address: "1.2.3.4", mode: "clone" } })[1] as Record<string, unknown>;
    const ws2 = clone2["ws-opts"] as { headers?: Record<string, string> };
    expect(ws2.headers?.Host).toBe("custom.example.com");
  });

  it("不同源用不同地址和模式", () => {
    const a = vlessWsTls({ name: "A" });
    const b = vlessWsTls({ name: "B", _sourceIds: ["src-b"] });
    const out = expandCfPreferredNodes([a, b], {
      "src-a": { address: "1.1.1.1", mode: "clone" },
      "src-b": { address: "2.2.2.2", mode: "replace" },
    });
    expect(out).toHaveLength(3);
    expect(out[0].name).toBe("A");
    expect(out[1].name).toBe("A-CF");
    expect(out[1].server).toBe("1.1.1.1");
    expect(out[2].name).toBe("B");
    expect(out[2].server).toBe("2.2.2.2");
  });
});

describe("buildCfPreferredClone", () => {
  it("不修改原节点对象，且不带原节点测活结果", () => {
    const node = vlessWsTls({ _health: { s1: { status: "ok", delayMs: 12, checkedAt: "t" } } });
    const clone = buildCfPreferredClone(node, "1.2.3.4") as unknown as Record<string, unknown>;
    expect(node.server).toBe("hk.example.com");
    expect(node.name).toBe("香港 IEPL-01");
    expect((node as unknown as Record<string, unknown>)["servername"]).toBeUndefined();
    expect((node as unknown as Record<string, unknown>)._health).toEqual({
      s1: { status: "ok", delayMs: 12, checkedAt: "t" },
    });
    expect(clone._health).toBeUndefined();
    expect(clone[CF_PREFERRED_OF_KEY]).toBe("香港 IEPL-01");
    expect(clone._originName).toBe("香港 IEPL-01-CF");
  });
});

describe("expandCfPreferredNodes idempotent / syncCfPreferredNodes", () => {
  it("已有同入口副本时不再生成第二个", () => {
    const original = vlessWsTls();
    const clone = buildCfPreferredClone(original, "1.2.3.4");
    const renamed = { ...clone, name: "香港加速" } as unknown as ParsedNode;
    const out = expandCfPreferredNodes([original, renamed], { "src-a": { address: "1.2.3.4", mode: "clone" } });
    expect(out).toHaveLength(2);
    expect(out[1].name).toBe("香港加速");
    expect(getCfPreferredOf(out[1])).toBe("香港 IEPL-01");
  });

  it("多个入口为每个 IP 生成一条副本", () => {
    const out = expandCfPreferredNodes([vlessWsTls()], {
      "src-a": { address: "1.1.1.1", addresses: ["1.1.1.1", "2.2.2.2"], mode: "clone" },
    });
    expect(out.map((n) => n.name)).toEqual(["香港 IEPL-01", "香港 IEPL-01-CF", "香港 IEPL-01-CF2"]);
    expect(out[1].server).toBe("1.1.1.1");
    expect(out[2].server).toBe("2.2.2.2");
  });

  it("关掉源时丢掉副本；改地址时只改入口并保留名字和测活", () => {
    const original = vlessWsTls();
    const clone = {
      ...buildCfPreferredClone(original, "1.2.3.4"),
      _health: { s1: { status: "ok", delayMs: 40, checkedAt: "t" } },
    } as unknown as ParsedNode;
    expect(syncCfPreferredNodes([original, clone], undefined).map((n) => n.name)).toEqual(["香港 IEPL-01"]);
    const updated = syncCfPreferredNodes([original, clone], { "src-a": { address: "9.9.9.9", mode: "clone" } });
    expect(updated).toHaveLength(2);
    expect(updated[1].name).toBe("香港 IEPL-01-CF");
    expect(updated[1].server).toBe("9.9.9.9");
    expect((updated[1] as unknown as Record<string, unknown>)._health).toEqual({
      s1: { status: "ok", delayMs: 40, checkedAt: "t" },
    });
  });

  it("applyCfPreferredToNodes 按源配置补副本", () => {
    const out = applyCfPreferredToNodes([vlessWsTls()], [
      { id: "src-a", cfPreferred: { enabled: true, address: "1.1.1.1" } },
    ]);
    expect(out.map((n) => n.name)).toEqual(["香港 IEPL-01", "香港 IEPL-01-CF"]);
    expect(out[1].server).toBe("1.1.1.1");
  });

  it("applyCfPreferredToNodes 按勾选的多个入口补副本", () => {
    const out = applyCfPreferredToNodes([vlessWsTls()], [
      {
        id: "src-a",
        cfPreferred: { enabled: true, address: "https://cf.example.com/ct", addresses: ["1.1.1.1", "8.8.8.8"] },
      },
    ]);
    expect(out.map((n) => n.name)).toEqual(["香港 IEPL-01", "香港 IEPL-01-CF", "香港 IEPL-01-CF2"]);
    expect(out[1].server).toBe("1.1.1.1");
    expect(out[2].server).toBe("8.8.8.8");
  });
});
