"use client";

import { HomeSurface, type HomeSurfaceAdapter } from "@subboost/ui/product/home/home-surface";
import { readJsonResponse, readSourceImportResponse } from "@subboost/ui/product/client-response";
import {
  createRulesProductApi,
  type NodeHealthCheckRequest,
  type NodeHealthCheckResponse,
} from "@subboost/ui/product/api-adapter";
import type { NodeHealthResult } from "@subboost/core/subscription/node-health";
import { LOCAL_AUTO_UPDATE_POLICY } from "@local/lib/auto-update-policy";

const localHomeAdapter: HomeSurfaceAdapter = {
  loginHref: "/login",
  templateUploadHref: "/templates?upload=1",
  productApi: {
    sourceImport: {
      importSource: async (request) => {
        const data = await readSourceImportResponse(
          await fetch("/api/source-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          })
        );
        return {
          content: typeof data.content === "string" ? data.content : "",
          headers: data.headers || {},
          parseResult: data.parseResult,
        };
      },
    },
    templates: {
      catalogEnabled: false,
      builtinEngagementEnabled: false,
    },
    rules: createRulesProductApi(),
    healthCheck: {
      runHealthCheck: async (request, onResult) => {
        // 流式 NDJSON：每个节点测完立即推送，前端逐行回显，无需等待全部完成
        const response = await fetch("/api/node-health", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          const data = await readJsonResponse<{ error?: string }>(response);
          throw new Error(data.error || "测活失败");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("测活失败：响应不支持流式读取");
        const decoder = new TextDecoder();
        let buffer = "";
        let summary = { tested: 0, ok: 0, fail: 0, unsupported: 0 };
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
              name?: string;
              sourceId?: string;
              result?: NodeHealthResult;
              summary?: typeof summary;
              message?: string;
            };
            if (message.type === "result" && message.name && message.sourceId && message.result) {
              onResult?.(message.name, message.sourceId, message.result);
            } else if (message.type === "done" && message.summary) {
              summary = message.summary;
            } else if (message.type === "error") {
              throw new Error(message.message || "测活失败");
            }
          }
        }
        return { nodes: [], summary } as NodeHealthCheckResponse;
      },
    },
  },
  loadSubscription: (id) => fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { cache: "no-store" }),
  subscription: {
    loginHref: "/login",
    autoUpdateIntervalPolicy: LOCAL_AUTO_UPDATE_POLICY,
    saveSubscription: ({ isEditing, subscriptionId, payload }) => {
      const endpoint =
        isEditing && subscriptionId
          ? `/api/subscriptions/${encodeURIComponent(subscriptionId)}`
          : "/api/subscriptions";
      return fetch(endpoint, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  },
};

export default function Page() {
  return <HomeSurface adapter={localHomeAdapter} />;
}
