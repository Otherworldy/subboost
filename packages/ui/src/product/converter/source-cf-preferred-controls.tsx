"use client";

import { Zap } from "lucide-react";
import type { CfPreferredSourceConfig } from "@subboost/core/types/config";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import { cn } from "@subboost/ui/lib/utils";

const DEFAULT_ADDRESS = "cf.090227.xyz";

export function defaultCfPreferredConfig(
  current?: CfPreferredSourceConfig,
  enabled = true,
): CfPreferredSourceConfig {
  return {
    enabled,
    address: current?.address?.trim() || DEFAULT_ADDRESS,
    mode: current?.mode === "replace" ? "replace" : "clone",
  };
}

/**
 * 源行的 CF 优选快捷开关（快速/高级模式共用）。
 * 视觉风格：琥珀色微章胶囊，状态一目了然，悬停提供详细策略，点击一键启停。
 */
export function SourceCfPreferredControls({
  source,
  onToggle,
}: {
  source: SubscriptionSource;
  onToggle: (config: CfPreferredSourceConfig) => void;
}) {
  const enabled = source.cfPreferred?.enabled === true;
  const address = source.cfPreferred?.address?.trim() || DEFAULT_ADDRESS;
  const modeText = source.cfPreferred?.mode === "replace" ? "直接替换" : "新增副本";

  const tooltip = enabled
    ? `CF 优选已开启：${address} (${modeText}) · 点击停用`
    : "点击开启 CF 优选加速（高级编辑中可自定义地址与模式）";

  return (
    <button
      type="button"
      onClick={() => onToggle(defaultCfPreferredConfig(source.cfPreferred, !enabled))}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        "group flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-all select-none",
        enabled
          ? "border border-amber-500/40 bg-amber-500/15 text-amber-300 shadow-sm shadow-amber-500/10 hover:border-amber-500/60 hover:bg-amber-500/25 active:scale-95"
          : "border border-white/10 bg-white/[0.03] text-white/35 hover:border-white/20 hover:bg-white/[0.08] hover:text-white/70 active:scale-95",
      )}
    >
      <Zap
        className={cn(
          "h-3.5 w-3.5 transition-all duration-200",
          enabled
            ? "fill-amber-300 text-amber-300 drop-shadow-[0_0_6px_rgba(251,191,36,0.5)] scale-105"
            : "text-white/35 group-hover:text-white/60",
        )}
        aria-hidden="true"
      />
      <span className="text-[10px] font-semibold tracking-wide">CF</span>
    </button>
  );
}
