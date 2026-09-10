import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import {
  CfPreferredSettings,
  toggleCfPreferredAddress,
  toggleGroupCfPreferredAddresses,
} from "./source-cf-preferred-settings";

const mockSource: SubscriptionSource = {
  id: "src-test-1",
  name: "测试订阅源",
  type: "url",
  content: "https://example.com/sub",
  enabled: true,
  cfPreferred: {
    enabled: true,
    strategy: "platform",
    mode: "clone",
    addresses: ["104.17.152.57"],
  },
};

describe("CfPreferredSettings", () => {
  it("渲染停用状态的卡片头部", () => {
    const disabledSource: SubscriptionSource = {
      ...mockSource,
      cfPreferred: { enabled: false },
    };
    const html = renderToStaticMarkup(
      React.createElement(CfPreferredSettings, {
        source: disabledSource,
        onUpdateMeta: vi.fn(),
      })
    );
    expect(html).toContain("Cloudflare 优选加速");
    expect(html).toContain("已停用");
  });

  it("渲染继承平台池策略及说明", () => {
    const html = renderToStaticMarkup(
      React.createElement(CfPreferredSettings, {
        source: mockSource,
        onUpdateMeta: vi.fn(),
      })
    );
    expect(html).toContain("继承平台入口池");
    expect(html).toContain("生成优选副本");
    expect(html).toContain("直接替换原入口");
    expect(html).toContain("已选");
    expect(html).toContain("全选");
    expect(html).toContain("全不选");
  });

  it("勾选从继承列表中只改当前项，不会塌成单选", () => {
    const implicit = ["a", "b", "c"];
    expect(toggleCfPreferredAddress([], "b", implicit)).toEqual(["a", "c"]);
    expect(toggleCfPreferredAddress(["a", "c"], "c", implicit)).toEqual(["a"]);
    expect(toggleCfPreferredAddress(["a"], "b", implicit)).toEqual(["a", "b"]);
    expect(toggleCfPreferredAddress([], "b", implicit, true)).toEqual(["b"]);
  });

  it("分组勾选在继承列表上只动该组", () => {
    const implicit = ["a", "b", "c"];
    expect(toggleGroupCfPreferredAddresses([], ["a", "b"], implicit)).toEqual(["c"]);
    expect(toggleGroupCfPreferredAddresses([], ["a", "b"], implicit, true)).toEqual(["a", "b"]);
    expect(toggleGroupCfPreferredAddresses(["c"], ["a", "b"], implicit, true)).toEqual(["c", "a", "b"]);
  });

  it("渲染单源专属覆盖策略及批量解析输入框", () => {
    const customSource: SubscriptionSource = {
      ...mockSource,
      cfPreferred: {
        enabled: true,
        strategy: "custom",
        mode: "replace",
        customLines: [
          { address: "104.17.152.57", label: "CF 电信优选", carrier: "telecom" },
        ],
        addresses: ["104.17.152.57"],
      },
    };
    const html = renderToStaticMarkup(
      React.createElement(CfPreferredSettings, {
        source: customSource,
        onUpdateMeta: vi.fn(),
      })
    );
    expect(html).toContain("专属覆盖");
    expect(html).toContain("单源专属覆盖");
    expect(html).toContain("批量添加线路 IP");
    expect(html).toContain("104.17.152.57");
    expect(html).toContain("CF 电信优选");
  });
});
