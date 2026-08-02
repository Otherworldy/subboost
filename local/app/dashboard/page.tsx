"use client";
import {
  SubscriptionDashboardSurface,
  type DashboardSurfaceAdapter,
} from "@subboost/ui/dashboard/subscription-dashboard-surface";
import { readJsonResponse } from "@subboost/ui/product/client-response";
import type { RefreshSubscriptionResponse, Subscription } from "@subboost/ui/dashboard/dashboard-types";
import { LOCAL_AUTO_UPDATE_POLICY } from "@local/lib/auto-update-policy";

// 刷新接口为 NDJSON 流：测活进度行实时回调，complete/error 行解析为最终结果
async function readRefreshStream(
  response: Response,
  onProgress?: (tested: number, total: number) => void
): Promise<RefreshSubscriptionResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("x-ndjson")) {
    return readJsonResponse<RefreshSubscriptionResponse>(response, "刷新失败");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("刷新失败：响应不支持流式读取");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as {
        type: string;
        tested?: number;
        total?: number;
        value?: unknown;
        message?: string;
      };
      if (message.type === "health" && typeof message.tested === "number" && typeof message.total === "number") {
        onProgress?.(message.tested, message.total);
      } else if (message.type === "complete") {
        return (message.value ?? {}) as RefreshSubscriptionResponse;
      } else if (message.type === "error") {
        throw new Error(message.message || "刷新失败");
      }
    }
  }
  throw new Error("刷新失败：响应不完整");
}

function resolveLocalDashboardDownloadUrl(subscription: Subscription): string {
  try {
    const url = new URL(subscription.subscriptionUrl, window.location.href);
    if (url.pathname.includes("/api/subscriptions/")) {
      return `${window.location.origin}${url.pathname}${url.search}`;
    }
  } catch {}
  return subscription.subscriptionUrl;
}

const localDashboardAdapter: DashboardSurfaceAdapter = {
  loginHref: "/login",
  newSubscriptionHref: "/?newSubscription=1",
  templatesHref: "/templates",
  settingsHref: "/dashboard/settings",
  settingsDescription: "查看本地管理员和运行状态",
  autoUpdateIntervalPolicy: LOCAL_AUTO_UPDATE_POLICY,
  fetchSubscriptions: async () => {
    const response = await fetch("/api/subscriptions");
    const data = await readJsonResponse<{ subscriptions?: Subscription[]; error?: string }>(response, "获取订阅失败");
    return Array.isArray(data.subscriptions) ? data.subscriptions : [];
  },
  deleteSubscription: async (id) => {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
    await readJsonResponse<{ error?: string }>(response, "删除失败");
  },
  refreshSubscription: async (id, onProgress) => {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await readRefreshStream(response, onProgress);
    return data;
  },
  updateSubscriptionSettings: async (id, payload) => {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await readJsonResponse<{ error?: string }>(response, "保存失败");
  },
  resolveDownloadUrl: resolveLocalDashboardDownloadUrl,
};

export default function DashboardPage() {
  return <SubscriptionDashboardSurface adapter={localDashboardAdapter} />;
}
