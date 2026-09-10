"use client";

import * as React from "react";
import { useConfigStore } from "@subboost/ui/store/config-store";

/** 转换器挂载时拉一次平台入口池，生成 CF 节点用 */
export function useCfPreferredPoolSync() {
  const setCfPreferredPool = useConfigStore((state) => state.setCfPreferredPool);

  React.useEffect(() => {
    let active = true;
    fetch("/api/cf-preferred/pool", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data?.pool) setCfPreferredPool(data.pool);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [setCfPreferredPool]);
}
