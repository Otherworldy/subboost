import { describe, expect, it } from "vitest";
import {
  activePoolAddresses,
  DEFAULT_CF_PREFERRED_POOL,
  mergePlatformCfPreferredPool,
  normalizeCfPreferredPoolConfig,
  parseCfPreferredBatchLines,
  withPoolEntryProbe,
} from "./cf-preferred-pool";

describe("normalizeCfPreferredPoolConfig", () => {
  it("空值 / 非法 JSON 回退默认", () => {
    expect(normalizeCfPreferredPoolConfig(null)).toEqual({ ...DEFAULT_CF_PREFERRED_POOL, entries: [] });
    expect(normalizeCfPreferredPoolConfig("{")).toEqual({ ...DEFAULT_CF_PREFERRED_POOL, entries: [] });
  });

  it("规范化条目：去重、拒绝 API URL、旧 role 映射为 enabled", () => {
    const pool = normalizeCfPreferredPoolConfig({
      enabled: true,
      mode: "replace",
      probeIntervalMinutes: 3,
      entries: [
        { address: " 104.16.1.1 ", carrier: "telecom", role: "active" },
        { address: "104.16.1.1", carrier: "unicom" },
        { address: "https://cf.example.com/ct", carrier: "mobile" },
        { address: "cu.cf.example.com", carrier: "unicom", role: "standby", pop: "FRA" },
        { address: "cf.090227.xyz", carrier: "optimized", enabled: true },
        { address: "5.5.5.5", carrier: "global", ms: 42, probeFrom: "browser" },
        { address: "6.6.6.6", carrier: "global", probeFrom: "nope" },
        { address: "7.7.7.7", carrier: "global", ms: 80 },
        { address: "8.8.8.8", carrier: "global", browserMs: 10, serverMs: 90, ms: 90 },
      ],
    });
    expect(pool.enabled).toBe(true);
    expect(pool.mode).toBe("replace");
    expect(pool.probeIntervalMinutes).toBe(5);
    expect(pool.entries.map((e) => e.address)).toEqual([
      "104.16.1.1",
      "cu.cf.example.com",
      "cf.090227.xyz",
      "5.5.5.5",
      "6.6.6.6",
      "7.7.7.7",
      "8.8.8.8",
    ]);
    expect(pool.entries[0]).toMatchObject({ carrier: "telecom", enabled: true });
    expect(pool.entries[1]).toMatchObject({ carrier: "unicom", enabled: false, pop: "FRA" });
    expect(pool.entries[2]).toMatchObject({ carrier: "optimized", enabled: true });
    expect(pool.entries[3]).toMatchObject({ ms: 42, browserMs: 42, probeFrom: "browser" });
    expect(pool.entries[4].probeFrom).toBeUndefined();
    expect(pool.entries[5]).toMatchObject({ ms: 80, serverMs: 80 });
    expect(pool.entries[6]).toMatchObject({ ms: 10, browserMs: 10, serverMs: 90 });
  });
});

describe("activePoolAddresses / mergePlatformCfPreferredPool", () => {
  const pool = normalizeCfPreferredPoolConfig({
    enabled: true,
    mode: "clone",
    entries: [
      { address: "1.1.1.1", carrier: "telecom", enabled: true, ms: 140 },
      { address: "2.2.2.2", carrier: "telecom", enabled: true, ms: 80 },
      { address: "3.3.3.3", carrier: "mobile", enabled: false, ms: 10 },
      { address: "4.4.4.4", carrier: "global", role: "circuit_open", ms: 20 },
    ],
  });

  it("只取已启用，按延迟排序", () => {
    expect(activePoolAddresses(pool)).toEqual(["2.2.2.2", "1.1.1.1"]);
    expect(activePoolAddresses({ ...pool, enabled: false })).toEqual([]);
  });

  it("注入排序优先用浏览器延迟，不通排最后", () => {
    const mixed = normalizeCfPreferredPoolConfig({
      enabled: true,
      entries: [
        { address: "1.1.1.1", carrier: "global", enabled: true, serverMs: 10, browserMs: 200 },
        { address: "2.2.2.2", carrier: "global", enabled: true, serverMs: 20, browserMs: null },
        { address: "3.3.3.3", carrier: "global", enabled: true, serverMs: 30 },
      ],
    });
    expect(activePoolAddresses(mixed)).toEqual(["3.3.3.3", "1.1.1.1", "2.2.2.2"]);
  });

  it("withPoolEntryProbe 只改一侧并回写有效 ms", () => {
    const base = {
      id: "a",
      address: "1.1.1.1",
      carrier: "global" as const,
      enabled: true,
      serverMs: 80,
      ms: 80,
    };
    const browser = withPoolEntryProbe(base, "browser", 12, "t");
    expect(browser).toMatchObject({ browserMs: 12, serverMs: 80, ms: 12, probeFrom: "browser" });
    expect(withPoolEntryProbe(browser, "server", null, "t2")).toMatchObject({
      browserMs: 12,
      serverMs: null,
      ms: 12,
      probeFrom: "server",
    });
  });

  it("给未覆盖的源注入平台入口；已勾选 addresses 的源保留", () => {
    const existing = {
      "src-keep": { address: "9.9.9.9", addresses: ["9.9.9.9"], mode: "replace" as const },
    };
    const merged = mergePlatformCfPreferredPool(
      [{ id: "src-keep" }, { id: "src-new" }, { id: "  " }],
      existing,
      pool,
    );
    expect(merged).toEqual({
      "src-keep": { address: "9.9.9.9", addresses: ["9.9.9.9"], mode: "replace" },
      "src-new": { address: "2.2.2.2", addresses: ["2.2.2.2", "1.1.1.1"], mode: "clone" },
    });
  });

  it("源上显式 addresses 为空时不注入平台入口", () => {
    expect(
      mergePlatformCfPreferredPool(
        [{ id: "src-none", cfPreferred: { enabled: true, addresses: [] } }],
        undefined,
        pool,
      ),
    ).toBeUndefined();
  });

  it("源打开 CF 时即使池总开关关闭也继承已启用入口", () => {
    const merged = mergePlatformCfPreferredPool(
      [{ id: "src-a", cfPreferred: { enabled: true, mode: "clone" } }],
      undefined,
      { ...pool, enabled: false },
    );
    expect(merged).toEqual({
      "src-a": { address: "2.2.2.2", addresses: ["2.2.2.2", "1.1.1.1"], mode: "clone" },
    });
  });

  it("未开启或没有已启用入口时不改现有规则", () => {
    const existing = { "src-a": { address: "1.1.1.1", mode: "clone" as const } };
    expect(mergePlatformCfPreferredPool([{ id: "src-a" }], existing, { ...pool, enabled: false })).toBe(existing);
    expect(mergePlatformCfPreferredPool([{ id: "src-a" }], undefined, { ...DEFAULT_CF_PREFERRED_POOL, enabled: true })).toBeUndefined();
  });
});

describe("parseCfPreferredBatchLines", () => {
  it("解析多行 IP#备注 并自动归类运营商", () => {
    const text = `
      // 注释行
      104.17.152.57#CF 电信优选
      8.35.211.74#CF 联通入口
      188.164.248.186#CF 移动CMI
      172.66.2.44#三网优化智能解析
      1.1.1.1#海外官方兜底
      104.17.152.57#重复地址应过滤
      https://cf.090227.xyz/test
    `;

    const parsed = parseCfPreferredBatchLines(text);
    expect(parsed).toEqual([
      { address: "104.17.152.57", label: "CF 电信优选", carrier: "telecom" },
      { address: "8.35.211.74", label: "CF 联通入口", carrier: "unicom" },
      { address: "188.164.248.186", label: "CF 移动CMI", carrier: "mobile" },
      { address: "172.66.2.44", label: "三网优化智能解析", carrier: "optimized" },
      { address: "1.1.1.1", label: "海外官方兜底", carrier: "global" },
      { address: "cf.090227.xyz", carrier: "optimized" },
    ]);
  });

  it("非法/空内容安全返回空数组", () => {
    expect(parseCfPreferredBatchLines("")).toEqual([]);
    expect(parseCfPreferredBatchLines("   \n\n  ")).toEqual([]);
  });
});
