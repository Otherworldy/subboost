import { afterEach, describe, expect, it } from "vitest";
import {
  clearCfPreferredResolveCache,
  fetchCfPreferredCandidates,
  prepareCfPreferredRules,
  resolveCfPreferredAddress,
  tcpingCandidates,
} from "./index";

afterEach(() => clearCfPreferredResolveCache());

function fetchReturning(text: string, ok = true) {
  return (async () => ({ ok, text: async () => text })) as unknown as typeof fetch;
}

describe("fetchCfPreferredCandidates", () => {
  it("纯 IPv4 直接返回", async () => {
    expect(await fetchCfPreferredCandidates("104.16.1.1")).toEqual(["104.16.1.1"]);
  });

  it("内网/保留地址一律拒绝", async () => {
    for (const bad of ["192.168.1.1", "10.0.0.2", "127.0.0.1", "169.254.1.1", "0.0.0.0"]) {
      expect(await fetchCfPreferredCandidates(bad)).toEqual([]);
    }
  });

  it("API URL：从返回文本提取公网 IPv4，过滤内网与非法值，封顶 64 个", async () => {
    const text = [
      "104.16.1.1",
      "10.0.0.5", // 内网剔除
      "999.1.1.1", // 非法剔除
      '"172.64.0.9",', // JSON 片段也能提取
      "not-an-ip",
    ].join("\n");
    const ips = await fetchCfPreferredCandidates("https://cf.example.com/ct", { fetchImpl: fetchReturning(text) });
    expect(ips).toEqual(["104.16.1.1", "172.64.0.9"]);
  });

  it("API URL 指向内网 host / 非法协议 / 非 2xx / 网络错误 → 空", async () => {
    expect(await fetchCfPreferredCandidates("https://192.168.1.1/api")).toEqual([]);
    expect(await fetchCfPreferredCandidates("ftp://cf.example.com")).toEqual([]);
    expect(await fetchCfPreferredCandidates("https://cf.example.com/x", { fetchImpl: fetchReturning("", false) })).toEqual([]);
    expect(
      await fetchCfPreferredCandidates("https://cf.example.com/x", {
        fetchImpl: (async () => {
          throw new Error("boom");
        }) as unknown as typeof fetch,
      }),
    ).toEqual([]);
  }, 15_000);

  it("域名走注入的 dohResolve 并过滤非 IPv4 与内网", async () => {
    const ips = await fetchCfPreferredCandidates("cf.example.com", {
      dohResolve: async () => ["104.16.2.2", "fe80::1", "192.168.0.1"],
    });
    expect(ips).toEqual(["104.16.2.2"]);
  });
});

describe("tcpingCandidates", () => {
  it("全部不可达时返回 null 延迟且保持原顺序（同分稳定）", async () => {
    const ranked = await tcpingCandidates(["203.0.113.1", "203.0.113.2"]); // TEST-NET，必然超时
    expect(ranked).toHaveLength(2);
    expect(ranked.every((c) => c.ms === null)).toBe(true);
  }, 15_000);

  it("去重输入", async () => {
    const ranked = await tcpingCandidates(["203.0.113.9", "203.0.113.9"]);
    expect(ranked).toHaveLength(1);
  }, 15_000);
});

describe("resolveCfPreferredAddress / prepareCfPreferredRules", () => {
  it("空串 → null；静态地址原样透传", async () => {
    expect(await resolveCfPreferredAddress("")).toBeNull();
    expect(await resolveCfPreferredAddress(" cf.090227.xyz ")).toBe("cf.090227.xyz");
  });

  it("API URL：拉取+测速选最优；成功结果进缓存", async () => {
    const deps = { fetchImpl: fetchReturning("104.16.1.7\n104.16.1.8") };
    const first = await resolveCfPreferredAddress("https://api/c", deps);
    expect(first).toMatch(/^104\.16\.1\.[78]$/);
    let calls = 0;
    const counting = { fetchImpl: (async (...args: unknown[]) => { calls += 1; return (fetchReturning("1.2.3.4") as (u: unknown) => unknown)(...args); }) as unknown as typeof fetch };
    await resolveCfPreferredAddress("https://api/c", counting);
    await resolveCfPreferredAddress("https://api/c", counting);
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("API 失败回退 lastKnownGood；无历史则 null 且不缓存", async () => {
    await resolveCfPreferredAddress("https://api/f", { fetchImpl: fetchReturning("104.16.3.3") });
    const fallback = await resolveCfPreferredAddress("https://api/f", { fetchImpl: fetchReturning("", false) });
    expect(fallback).toBe("104.16.3.3");

    const never = await resolveCfPreferredAddress("https://api/n", { fetchImpl: fetchReturning("", false) });
    expect(never).toBeNull();
    clearCfPreferredResolveCache();
  });

  it("prepareCfPreferredRules：按源解析，未开启/失败源跳过", async () => {
    expect(await prepareCfPreferredRules({})).toBeUndefined();
    const mapped = await prepareCfPreferredRules({
      sources: [
        { id: "src-a", cfPreferred: { enabled: true, address: "cf.090227.xyz" } },
        { id: "src-b", cfPreferred: { enabled: true, address: "https://api/c", mode: "replace" } },
        { id: "src-c", cfPreferred: { enabled: true, address: "https://api/fail" } },
        { id: "src-d", cfPreferred: { enabled: false, address: "1.2.3.4" } },
      ],
    }, { fetchImpl: (async (url: string) => {
      if (String(url).includes("/fail")) return { ok: false, text: async () => "" };
      return { ok: true, text: async () => "104.16.9.9" };
    }) as unknown as typeof fetch });
    expect(mapped).toEqual({
      "src-a": { address: "cf.090227.xyz", mode: "clone" },
      "src-b": { address: "104.16.9.9", mode: "replace" },
    });
  });

  it("prepareCfPreferredRules：已勾选入口时不再解析 API", async () => {
    const mapped = await prepareCfPreferredRules({
      sources: [
        {
          id: "src-a",
          cfPreferred: {
            enabled: true,
            address: "https://api/c",
            addresses: ["1.1.1.1", "2.2.2.2"],
          },
        },
      ],
    }, { fetchImpl: fetchReturning("104.16.9.9") });
    expect(mapped).toEqual({
      "src-a": { address: "1.1.1.1", addresses: ["1.1.1.1", "2.2.2.2"], mode: "clone" },
    });
  });
});
