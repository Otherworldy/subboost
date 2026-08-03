import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import {
  DEFAULT_HEALTH_CHECK,
  HEALTH_CHECK_CONCURRENCY_MAX,
  HEALTH_CHECK_CONCURRENCY_MIN,
  HEALTH_CHECK_MAX_DELAY_MAX_MS,
  HEALTH_CHECK_MAX_DELAY_MIN_MS,
  HEALTH_RESULTS_KEY,
  filterNodesByHealth,
  getHealthCheckCacheConfigKey,
  getNodeHealthResults,
  isNodeVisibleToDownstream,
  normalizeHealthCheckUrl,
  normalizeSourceHealthCheck,
  resolveSourceHealthCheck,
  stripNodeHealthFields,
  summarizeNodeHealth,
  withNodeHealthResult,
  withoutNodeHealthResultsForSources,
} from "./node-health";
import { ORIGIN_NAME_KEY, SOURCE_IDS_KEY } from "./node-source-state";

function node(overrides: Record<string, unknown> = {}): ParsedNode {
  return { name: "Node", type: "vmess", server: "example.com", port: 443, ...overrides } as ParsedNode;
}

const source = (id: string, healthCheck?: Record<string, unknown>) => ({
  id,
  ...(healthCheck ? { healthCheck } : {}),
});

describe("normalizeHealthCheckUrl", () => {
  it("accepts http(s) and canonicalizes scheme-less hostnames", () => {
    expect(normalizeHealthCheckUrl("https://www.google.com/")).toBe("https://www.google.com/");
    expect(normalizeHealthCheckUrl(" http://example.com/a ")).toBe("http://example.com/a");
    expect(normalizeHealthCheckUrl("www.google.com")).toBe("https://www.google.com/");
  });

  it("rejects non-http(s) and invalid values", () => {
    expect(normalizeHealthCheckUrl("ftp://example.com")).toBeUndefined();
    expect(normalizeHealthCheckUrl("not a url")).toBeUndefined();
    expect(normalizeHealthCheckUrl("")).toBeUndefined();
    expect(normalizeHealthCheckUrl(123)).toBeUndefined();
  });
});

describe("normalizeSourceHealthCheck", () => {
  it("enforces bounds for maxDelayMs and concurrency", () => {
    expect(
      normalizeSourceHealthCheck({
        enabled: true,
        url: "https://www.google.com",
        maxDelayMs: HEALTH_CHECK_MAX_DELAY_MIN_MS,
        concurrency: HEALTH_CHECK_CONCURRENCY_MIN,
      })
    ).toEqual({
      enabled: true,
      url: "https://www.google.com/",
      maxDelayMs: 100,
      concurrency: 1,
    });

    expect(
      normalizeSourceHealthCheck({
        maxDelayMs: HEALTH_CHECK_MAX_DELAY_MAX_MS,
        concurrency: HEALTH_CHECK_CONCURRENCY_MAX,
      })
    ).toEqual({ maxDelayMs: 60000, concurrency: 100 });

    expect(
      normalizeSourceHealthCheck({
        enabled: true,
        maxDelayMs: 99,
        concurrency: 101,
        url: "ftp://example.com",
      })
    ).toEqual({ enabled: true });
  });

  it("returns undefined for missing or empty configs", () => {
    expect(normalizeSourceHealthCheck(undefined)).toBeUndefined();
    expect(normalizeSourceHealthCheck("x")).toBeUndefined();
    expect(normalizeSourceHealthCheck([])).toBeUndefined();
    expect(normalizeSourceHealthCheck({})).toBeUndefined();
  });
});

describe("resolveSourceHealthCheck", () => {
  it("defaults to disabled with the shared defaults", () => {
    expect(resolveSourceHealthCheck({})).toEqual({ ...DEFAULT_HEALTH_CHECK, enabled: false });
    expect(resolveSourceHealthCheck(undefined)).toEqual({ ...DEFAULT_HEALTH_CHECK, enabled: false });
  });

  it("uses probe settings but not the automatic switch in cache keys", () => {
    const enabled = { healthCheck: { enabled: true, maxDelayMs: 1200 } };
    const disabled = { healthCheck: { enabled: false, maxDelayMs: 1200 } };
    const changed = { healthCheck: { enabled: true, maxDelayMs: 1300 } };
    const changedUrl = { healthCheck: { enabled: true, maxDelayMs: 1200, url: "https://example.com/ping" } };
    const changedConcurrency = { healthCheck: { enabled: true, maxDelayMs: 1200, concurrency: 8 } };

    expect(getHealthCheckCacheConfigKey(enabled)).toBe(getHealthCheckCacheConfigKey(disabled));
    expect(getHealthCheckCacheConfigKey(enabled)).not.toBe(getHealthCheckCacheConfigKey(changed));
    expect(getHealthCheckCacheConfigKey(enabled)).not.toBe(getHealthCheckCacheConfigKey(changedUrl));
    expect(getHealthCheckCacheConfigKey(enabled)).not.toBe(getHealthCheckCacheConfigKey(changedConcurrency));
  });

  it("applies partial overrides", () => {
    expect(
      resolveSourceHealthCheck({
        healthCheck: { enabled: true, maxDelayMs: 1200 },
      })
    ).toEqual({ enabled: true, url: DEFAULT_HEALTH_CHECK.url, maxDelayMs: 1200, concurrency: 20 });
  });
});

describe("node health results", () => {
  it("reads only well-formed results", () => {
    const n = node({
      [HEALTH_RESULTS_KEY]: {
        a: { status: "ok", delayMs: 100, checkedAt: "2026-01-01T00:00:00.000Z" },
        b: { status: "fail", checkedAt: "2026-01-01T00:00:00.000Z" },
        c: { status: "wat" },
        d: "x",
        e: { status: "ok", delayMs: Number.NaN, checkedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    expect(getNodeHealthResults(n)).toEqual({
      a: { status: "ok", delayMs: 100, checkedAt: "2026-01-01T00:00:00.000Z" },
      b: { status: "fail", checkedAt: "2026-01-01T00:00:00.000Z" },
      e: { status: "ok", checkedAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("writes per-source results without dropping other sources", () => {
    const n = withNodeHealthResult(node(), "a", { status: "ok", delayMs: 100, checkedAt: "t1" });
    const next = withNodeHealthResult(n, "b", { status: "fail", checkedAt: "t2" });
    const replaced = withNodeHealthResult(next, "a", { status: "ok", delayMs: 80, checkedAt: "t3" });
    expect(getNodeHealthResults(replaced)).toEqual({
      a: { status: "ok", delayMs: 80, checkedAt: "t3" },
      b: { status: "fail", checkedAt: "t2" },
    });
  });

  it("removes only requested source results and drops the key when empty", () => {
    const n = withNodeHealthResult(
      withNodeHealthResult(node(), "a", { status: "fail", checkedAt: "t1" }),
      "b",
      { status: "fail", checkedAt: "t2" }
    );
    const after = withoutNodeHealthResultsForSources(n, ["a"]);
    expect(getNodeHealthResults(after)).toEqual({ b: { status: "fail", checkedAt: "t2" } });
    expect(withoutNodeHealthResultsForSources(after, ["b"])).not.toHaveProperty(HEALTH_RESULTS_KEY);
  });
});

describe("summarizeNodeHealth", () => {
  it("reports untested when no results exist", () => {
    expect(summarizeNodeHealth(node())).toEqual({ status: "untested" });
  });

  it("picks the fastest successful delay", () => {
    const n = withNodeHealthResult(
      withNodeHealthResult(node(), "a", { status: "ok", delayMs: 500, checkedAt: "t1" }),
      "b",
      { status: "ok", delayMs: 120, checkedAt: "t2" }
    );
    expect(summarizeNodeHealth(n)).toEqual({ status: "ok", delayMs: 120, checkedAt: "t2" });
  });

  it("falls back to fail or unsupported when nothing passed", () => {
    const failed = withNodeHealthResult(node(), "a", { status: "fail", checkedAt: "t1" });
    expect(summarizeNodeHealth(failed)).toEqual({ status: "fail", checkedAt: "t1" });

    const unsupported = withNodeHealthResult(node(), "a", { status: "unsupported", checkedAt: "t1" });
    expect(summarizeNodeHealth(unsupported)).toEqual({ status: "unsupported", checkedAt: "t1" });
  });
});

describe("isNodeVisibleToDownstream", () => {
  const sources = [
    source("plain"),
    source("auto", { enabled: true }),
    source("auto2", { enabled: true }),
  ];

  it("keeps nodes without source ids visible", () => {
    expect(isNodeVisibleToDownstream(node(), sources)).toBe(true);
  });

  it("keeps nodes from unknown or untested sources visible", () => {
    expect(isNodeVisibleToDownstream(node({ [SOURCE_IDS_KEY]: ["plain"] }), sources)).toBe(true);
    expect(isNodeVisibleToDownstream(node({ [SOURCE_IDS_KEY]: ["ghost"] }), sources)).toBe(true);
  });

  it("hides nodes only when every known source failed or is unsupported", () => {
    const allFailed = withNodeHealthResult(
      withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["auto", "auto2"] }), "auto", {
        status: "fail",
        checkedAt: "t1",
      }),
      "auto2",
      { status: "fail", checkedAt: "t2" }
    );
    expect(isNodeVisibleToDownstream(allFailed, sources)).toBe(false);

    const oneUnsupported = withNodeHealthResult(
      withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["auto", "auto2"] }), "auto", {
        status: "unsupported",
        checkedAt: "t1",
      }),
      "auto2",
      { status: "fail", checkedAt: "t2" }
    );
    expect(isNodeVisibleToDownstream(oneUnsupported, sources)).toBe(false);
  });

  it("keeps nodes with any ok result or an untested source", () => {
    const anyOk = withNodeHealthResult(
      withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["auto", "auto2"] }), "auto", {
        status: "fail",
        checkedAt: "t1",
      }),
      "auto2",
      { status: "ok", delayMs: 50, checkedAt: "t2" }
    );
    expect(isNodeVisibleToDownstream(anyOk, sources)).toBe(true);

    const untested = node({ [SOURCE_IDS_KEY]: ["auto"] });
    expect(isNodeVisibleToDownstream(untested, sources)).toBe(true);

    const mixed = withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["auto", "plain"] }), "auto", {
      status: "fail",
      checkedAt: "t1",
    });
    expect(isNodeVisibleToDownstream(mixed, sources)).toBe(true);
  });

  it("keeps nodes visible when a source has automatic health checks disabled", () => {
    // 关闭自动测活的源不参与过滤：残留的手动测活失败结果不影响可见性
    const manualFail = withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["plain"] }), "plain", {
      status: "fail",
      checkedAt: "t1",
    });
    expect(isNodeVisibleToDownstream(manualFail, sources)).toBe(true);

    const mixed = withNodeHealthResult(
      withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["plain", "auto"] }), "plain", {
        status: "fail",
        checkedAt: "t1",
      }),
      "auto",
      { status: "fail", checkedAt: "t2" }
    );
    expect(isNodeVisibleToDownstream(mixed, sources)).toBe(true);

    const allAutoFailed = withNodeHealthResult(
      withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["auto", "auto2"] }), "auto", {
        status: "fail",
        checkedAt: "t1",
      }),
      "auto2",
      { status: "fail", checkedAt: "t2" }
    );
    expect(isNodeVisibleToDownstream(allAutoFailed, sources)).toBe(false);
  });
});

describe("filterNodesByHealth", () => {
  it("uses config.sources descriptors", () => {
    const failed = withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["auto"] }), "auto", {
      status: "fail",
      checkedAt: "t1",
    });
    const passed = withNodeHealthResult(node({ [SOURCE_IDS_KEY]: ["auto"] }), "auto", {
      status: "ok",
      delayMs: 10,
      checkedAt: "t1",
    });
    const config = { sources: [source("auto", { enabled: true })] };
    expect(filterNodesByHealth([failed, passed], config).map((n) => n.name)).toEqual(["Node"]);
    expect(filterNodesByHealth([failed], {})).toHaveLength(1);
  });
});

describe("stripNodeHealthFields", () => {
  it("removes only internal metadata fields", () => {
    const n = node({
      [HEALTH_RESULTS_KEY]: { a: { status: "fail", checkedAt: "t1" } },
      [SOURCE_IDS_KEY]: ["a"],
      [ORIGIN_NAME_KEY]: "origin",
      udp: true,
    });
    expect(stripNodeHealthFields(n)).toEqual({
      name: "Node",
      type: "vmess",
      server: "example.com",
      port: 443,
      udp: true,
    });
  });
});
