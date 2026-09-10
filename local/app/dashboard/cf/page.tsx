"use client";

import { CfPreferredPoolSurface, type CfPreferredPoolAdapter } from "@subboost/ui/dashboard/cf-preferred-pool-surface";
import { readJsonResponse } from "@subboost/ui/product/client-response";
import type { CfPreferredPoolConfig } from "@subboost/core/types/config";

const localCfPreferredAdapter: CfPreferredPoolAdapter = {
  fetchPool: async () => {
    const response = await fetch("/api/cf-preferred/pool", { cache: "no-store" });
    return readJsonResponse<{ pool: CfPreferredPoolConfig; subscriptionCount: number }>(response, "加载入口池失败");
  },
  savePool: async (pool) => {
    const response = await fetch("/api/cf-preferred/pool", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool }),
    });
    const data = await readJsonResponse<{ pool: CfPreferredPoolConfig }>(response, "保存入口池失败");
    return data.pool;
  },
  probePool: async (entryId?: string) => {
    const response = await fetch("/api/cf-preferred/pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "probe", ...(entryId ? { entryId } : {}) }),
    });
    const data = await readJsonResponse<{ pool: CfPreferredPoolConfig }>(response, "探活失败");
    return data.pool;
  },
  resolveAddress: async (address) => {
    const response = await fetch("/api/cf-preferred/pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve", address }),
    });
    const data = await readJsonResponse<{ candidates?: { ip: string; ms: number | null }[] }>(response, "解析失败");
    return Array.isArray(data.candidates) ? data.candidates : [];
  },
};

export default function CfPreferredPoolPage() {
  return <CfPreferredPoolSurface adapter={localCfPreferredAdapter} />;
}
