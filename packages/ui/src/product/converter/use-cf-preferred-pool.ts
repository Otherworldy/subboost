"use client";

import * as React from "react";
import { normalizeCfPreferredPoolConfig } from "@subboost/core/subscription/cf-preferred-pool";
import type { CfPreferredPoolConfig } from "@subboost/core/types/config";
import { useConfigStore } from "@subboost/ui/store/config-store";

const POOL_CACHE_KEY = "subboost.cfPreferredPool.v1";
let memoryPool: CfPreferredPoolConfig | null = null;

export function peekCfPreferredPool(): CfPreferredPoolConfig | null {
  if (memoryPool) return memoryPool;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(POOL_CACHE_KEY);
    if (!raw) return null;
    memoryPool = normalizeCfPreferredPoolConfig(JSON.parse(raw));
    return memoryPool;
  } catch {
    return null;
  }
}

function rememberCfPreferredPool(pool: CfPreferredPoolConfig) {
  memoryPool = pool;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(POOL_CACHE_KEY, JSON.stringify(pool));
  } catch {
    // quota / private mode
  }
}

/** 转换器挂载时拉一次平台入口池，生成 CF 节点用 */
export function useCfPreferredPoolSync() {
  const setCfPreferredPool = useConfigStore((state) => state.setCfPreferredPool);

  React.useEffect(() => {
    const cached = peekCfPreferredPool();
    if (cached) setCfPreferredPool(cached);
    let active = true;
    fetch("/api/cf-preferred/pool", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data?.pool) return;
        rememberCfPreferredPool(data.pool);
        setCfPreferredPool(data.pool);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [setCfPreferredPool]);
}
