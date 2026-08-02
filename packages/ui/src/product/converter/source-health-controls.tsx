"use client";

import { Activity, Loader2 } from "lucide-react";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import { IconButton } from "@subboost/ui/components/ui/icon-button";
import { Switch } from "@subboost/ui/components/ui/switch";

/**
 * 源行的自动测活开关 + 立即测活按钮（快速/高级模式共用）。
 * proxy-providers 模式节点不进入 SubBoost，禁用自动测活。
 */
export function SourceHealthControls({
  source,
  checking,
  onCheck,
  onToggleAuto,
}: {
  source: SubscriptionSource;
  checking: boolean;
  onCheck: () => void;
  onToggleAuto: (enabled: boolean) => void;
}) {
  const isProviderMode = source.type === "url" && Boolean(source.useProxyProviders);
  const autoEnabled = Boolean(source.healthCheck?.enabled);

  return (
    <div className="flex items-center gap-1">
      <span
        title={
          isProviderMode
            ? "proxy-providers 模式节点由客户端拉取，不支持自动测活"
            : autoEnabled
              ? "自动测活已开启：刷新时只保留通过测活的节点"
              : "自动测活已关闭"
        }
      >
        <Switch
          checked={autoEnabled}
          disabled={isProviderMode}
          onCheckedChange={onToggleAuto}
          aria-label="自动测活"
          className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
        />
      </span>
      <IconButton
        label={checking ? "测活中..." : "立即测活该源"}
        variant="ghost"
        onClick={onCheck}
        disabled={checking}
        className="h-6 w-6 rounded p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-emerald-300 disabled:opacity-60"
      >
        {checking ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Activity className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </IconButton>
    </div>
  );
}
