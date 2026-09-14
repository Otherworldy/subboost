import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CfPreferredPoolSurface, type CfPreferredPoolAdapter } from "./cf-preferred-pool-surface";

vi.mock("@subboost/ui/components/ui/toaster", () => ({ toast: vi.fn() }));
vi.mock("@subboost/ui/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

function adapter(overrides: Partial<CfPreferredPoolAdapter> = {}): CfPreferredPoolAdapter {
  return {
    fetchPool: vi.fn(async () => ({
      pool: { enabled: false, mode: "clone" as const, probeIntervalMinutes: 15, entries: [] },
      subscriptionCount: 2,
    })),
    savePool: vi.fn(async (pool) => pool),
    probePool: vi.fn(async () => ({ enabled: true, mode: "clone" as const, probeIntervalMinutes: 15, entries: [] })),
    resolveAddress: vi.fn(async () => []),
    ...overrides,
  };
}

describe("CfPreferredPoolSurface", () => {
  it("renders platform pool heading and actions", () => {
    const html = renderToStaticMarkup(React.createElement(CfPreferredPoolSurface, { adapter: adapter() }));
    expect(html).toContain("Cloudflare 平台级入口加速");
    expect(html).toContain("浏览器探活");
    expect(html).toContain("服务器探活");
    expect(html).toContain("新增入口");
    expect(html).toContain("三网优化");
    expect(html).toContain("中国电信");
    expect(html).toContain("新增优选副本");
  });
});
