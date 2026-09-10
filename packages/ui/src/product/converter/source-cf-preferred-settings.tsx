"use client";

import * as React from "react";
import {
  Loader2,
  Rocket,
  Trash2,
  Zap,
} from "lucide-react";
import {
  normalizeCfPreferredAddresses,
} from "@subboost/core/subscription/cf-preferred";
import {
  parseCfPreferredBatchLines,
} from "@subboost/core/subscription/cf-preferred-pool";
import {
  CF_PREFERRED_CARRIERS,
  CF_PREFERRED_CARRIER_LABELS,
  type CfPreferredCarrier,
  type CfPreferredCustomEntry,
  type CfPreferredMode,
  type CfPreferredPoolConfig,
  type CfPreferredPoolEntry,
  type CfPreferredSourceConfig,
  type CfPreferredStrategy,
} from "@subboost/core/types/config";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import { Badge } from "@subboost/ui/components/ui/badge";
import { Button } from "@subboost/ui/components/ui/button";
import { HelpPopover } from "@subboost/ui/components/ui/popover";
import { Switch } from "@subboost/ui/components/ui/switch";
import { Textarea } from "@subboost/ui/components/ui/textarea";
import { cn } from "@subboost/ui/lib/utils";
import { useConfigStore, type SubscriptionSource } from "@subboost/ui/store/config-store";
import { defaultCfPreferredConfig } from "./source-cf-preferred-controls";

type ProbeStatus = {
  loading: boolean;
  ms?: number | null;
  ok?: number;
  total?: number;
  error?: string | null;
};

const SAMPLE_BATCH_TEXT = `104.17.152.57#CF 电信优选
8.35.211.74#CF 电信优选
8.35.211.158#CF 电信优选
188.164.248.186#CF 电信优选
172.66.2.44#CF 电信优选
8.35.211.40#CF 电信优选`;

/** explicit=false 且 selected 为空时继承 implicitAll；explicit 时空数组就是全不选 */
export function effectiveCfPreferredSelection(
  selected: string[],
  implicitAll: string[],
  explicit = selected.length > 0,
): string[] {
  return explicit ? selected : implicitAll;
}

export function toggleCfPreferredAddress(
  selected: string[],
  addr: string,
  implicitAll: string[],
  explicit = selected.length > 0,
): string[] {
  const current = effectiveCfPreferredSelection(selected, implicitAll, explicit);
  return current.includes(addr)
    ? current.filter((item) => item !== addr)
    : [...current, addr];
}

export function toggleGroupCfPreferredAddresses(
  selected: string[],
  groupAddrs: string[],
  implicitAll: string[],
  explicit = selected.length > 0,
): string[] {
  const current = effectiveCfPreferredSelection(selected, implicitAll, explicit);
  const allOn = groupAddrs.length > 0 && groupAddrs.every((addr) => current.includes(addr));
  return allOn
    ? current.filter((addr) => !groupAddrs.includes(addr))
    : [...new Set([...current, ...groupAddrs])];
}

const CARRIER_BADGES: Record<CfPreferredCarrier, { badge: string; dot: string; desc: string }> = {
  optimized: {
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    dot: "bg-emerald-400",
    desc: "智能 Anycast 全网调度",
  },
  telecom: {
    badge: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    dot: "bg-blue-400",
    desc: "CN2 / 163 骨干专属",
  },
  unicom: {
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    dot: "bg-amber-400",
    desc: "AS4837 / AS9929 直连",
  },
  mobile: {
    badge: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    dot: "bg-cyan-400",
    desc: "CMI 香港 / 新加坡路由",
  },
  global: {
    badge: "bg-purple-500/15 text-purple-300 border-purple-500/30",
    dot: "bg-purple-400",
    desc: "海外 Anycast 备选",
  },
};

export function CfPreferredSettings({
  source,
  onUpdateMeta,
}: {
  source: SubscriptionSource;
  onUpdateMeta: (id: string, patch: Partial<SubscriptionSource>) => void;
}) {
  const config = source.cfPreferred;
  const enabled = config?.enabled === true;
  const currentStrategy: CfPreferredStrategy = config?.strategy ?? "platform";
  const currentMode: CfPreferredMode = config?.mode ?? "clone";
  const selectedAddresses = React.useMemo(
    () => normalizeCfPreferredAddresses(config?.addresses),
    [config?.addresses],
  );

  // 平台池状态拉取
  const [platformPool, setPlatformPool] = React.useState<CfPreferredPoolConfig | null>(null);
  const [loadingPool, setLoadingPool] = React.useState(false);

  // 单线测速状态记录 key: address
  const [probeMap, setProbeMap] = React.useState<Record<string, ProbeStatus>>({});

  // 自定义批量解析文本框
  const [rawBatchText, setRawBatchText] = React.useState(config?.rawCustomText ?? "");

  // 自定义线路条目列表
  const customLines = React.useMemo<CfPreferredCustomEntry[]>(() => {
    return Array.isArray(config?.customLines) ? config.customLines : [];
  }, [config?.customLines]);

  // 组件挂载时拉取平台池
  React.useEffect(() => {
    let active = true;
    setLoadingPool(true);
    fetch("/api/cf-preferred/pool", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active) return;
        if (data?.pool) setPlatformPool(data.pool);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingPool(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateConfig = (patch: Partial<CfPreferredSourceConfig>) => {
    const nextEnabled = patch.enabled ?? enabled;
    onUpdateMeta(source.id, {
      cfPreferred: defaultCfPreferredConfig({ ...config, ...patch }, nextEnabled),
    });
  };

  // 真实节点替换单线测速
  async function runSingleProbe(targetAddress: string) {
    const addr = targetAddress.trim();
    if (!addr) return;

    setProbeMap((prev) => ({
      ...prev,
      [addr]: { loading: true },
    }));

    try {
      const sourceNodes = useConfigStore
        .getState()
        .nodes.filter((node) => getNodeSourceIds(node).includes(source.id));

      const response = await fetch("/api/cf-preferred/preview", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: addr,
          sourceId: source.id,
          nodes: sourceNodes,
          mode: currentMode,
          ...(source.healthCheck ? { healthCheck: source.healthCheck } : {}),
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "测速失败");
      }

      const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
      setProbeMap((prev) => ({
        ...prev,
        [addr]: {
          loading: false,
          ms: candidate ? candidate.ms : null,
          ok: candidate?.ok,
          total: candidate?.nodes?.length ?? 0,
        },
      }));
    } catch (err) {
      setProbeMap((prev) => ({
        ...prev,
        [addr]: {
          loading: false,
          error: err instanceof Error ? err.message : "测速失败",
        },
      }));
    }
  }

  // 批量文本解析追加到自定义列表
  const handleParseAndAppend = () => {
    const parsed = parseCfPreferredBatchLines(rawBatchText);
    if (parsed.length === 0) return;

    const seen = new Set(customLines.map((l) => l.address.toLowerCase()));
    const newItems: CfPreferredCustomEntry[] = [];

    for (const item of parsed) {
      if (seen.has(item.address.toLowerCase())) continue;
      seen.add(item.address.toLowerCase());
      newItems.push({
        address: item.address,
        label: item.label,
        carrier: item.carrier,
      });
    }

    const nextCustomLines = [...customLines, ...newItems];
    // 默认勾选全部自定义地址
    const nextAddresses = Array.from(new Set([...selectedAddresses, ...newItems.map((i) => i.address)]));

    updateConfig({
      strategy: "custom",
      customLines: nextCustomLines,
      addresses: nextAddresses,
      rawCustomText: rawBatchText,
      enabled: true,
    });
  };

  // 删除自定义线路单条
  const handleDeleteCustomLine = (addr: string) => {
    const nextLines = customLines.filter((l) => l.address !== addr);
    const nextAddresses = selectedAddresses.filter((a) => a !== addr);
    updateConfig({
      customLines: nextLines,
      addresses: nextAddresses,
    });
  };

  const platformEntries = platformPool?.entries ?? [];
  const platformEnabledAddrs = platformEntries.filter((entry) => entry.enabled).map((entry) => entry.address);
  const platformAllAddrs = platformEntries.map((entry) => entry.address);
  const hasExplicitSelection = currentStrategy === "platform" && Array.isArray(config?.addresses);
  const platformSelected = effectiveCfPreferredSelection(
    selectedAddresses,
    currentStrategy === "platform" ? platformEnabledAddrs : [],
    hasExplicitSelection,
  );

  const toggleAddressSelected = (addr: string) => {
    const implicitAll = currentStrategy === "platform" ? platformEnabledAddrs : selectedAddresses;
    const explicit = currentStrategy === "platform" ? hasExplicitSelection : true;
    updateConfig({
      addresses: toggleCfPreferredAddress(selectedAddresses, addr, implicitAll, explicit),
      enabled: true,
    });
  };

  // 平台池线路条目（按运营商分组）
  const platformGroupedEntries = React.useMemo(() => {
    const map: Record<CfPreferredCarrier, CfPreferredPoolEntry[]> = {
      optimized: [],
      telecom: [],
      unicom: [],
      mobile: [],
      global: [],
    };
    if (platformPool?.entries) {
      for (const entry of platformPool.entries) {
        if (map[entry.carrier]) {
          map[entry.carrier].push(entry);
        }
      }
    }
    return map;
  }, [platformPool?.entries]);

  const handleSelectAllPlatform = () => {
    if (platformAllAddrs.length === 0) return;
    updateConfig({ addresses: platformAllAddrs, enabled: true });
  };

  const handleClearAllPlatform = () => {
    updateConfig({ addresses: [], enabled: true });
  };

  const handleToggleGroupPlatform = (groupAddrs: string[]) => {
    if (groupAddrs.length === 0) return;
    updateConfig({
      addresses: toggleGroupCfPreferredAddresses(
        selectedAddresses,
        groupAddrs,
        platformEnabledAddrs,
        hasExplicitSelection,
      ),
      enabled: true,
    });
  };

  // 一键测速所有已勾选的平台池线路
  const handleBatchProbePlatform = () => {
    platformSelected.forEach((addr, i) => {
      setTimeout(() => void runSingleProbe(addr), i * 180);
    });
  };

  // 一键测速所有自定义线路
  const handleBatchProbeCustom = () => {
    customLines.forEach((item, i) => {
      setTimeout(() => void runSingleProbe(item.address), i * 180);
    });
  };

  const isPlatformActive = platformPool?.enabled === true;

  return (
    <div
      className={cn(
        "rounded-2xl border transition-all duration-300",
        enabled
          ? "border-amber-500/40 bg-gradient-to-b from-amber-500/[0.07] to-transparent p-3 shadow-lg shadow-amber-950/20"
          : "border-white/10 bg-white/[0.02] p-3",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Zap
            className={cn("h-3.5 w-3.5 shrink-0", enabled ? "fill-amber-300/30 text-amber-300" : "text-white/35")}
            aria-hidden="true"
          />
          <span className="text-xs font-semibold text-white/90">Cloudflare 优选加速</span>
          <Badge
            variant="outline"
            className={cn(
              "border px-1.5 py-0 text-[10px] font-medium leading-4",
              enabled
                ? currentStrategy === "custom"
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                  : "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-white/5 text-white/40",
            )}
          >
            {enabled
              ? currentStrategy === "custom"
                ? `专属 ${customLines.length}`
                : `已选 ${platformSelected.length}`
              : "已停用"}
          </Badge>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <HelpPopover
            label="CF 优选说明"
            side="bottom"
            align="end"
            contentClassName="w-[340px] bg-[#141416] p-4 border-white/15 shadow-2xl text-xs space-y-2.5"
          >
            <div className="flex items-center gap-1.5 font-medium text-amber-300">
              <Zap className="h-4 w-4 fill-amber-300/40" />
              <span>CF 优选加速机制</span>
            </div>
            <p className="leading-relaxed text-white/70 text-[11px]">
              适用于套了 Cloudflare CDN 的 <span className="font-mono text-white/90">VLESS / VMess / Trojan</span>（WS/gRPC 等 + TLS）节点。
            </p>
            <div className="space-y-1.5 rounded-lg bg-white/5 p-2.5 text-[11px] text-white/60">
              <p>• <strong className="text-white/85">继承平台入口池：</strong>统一继承平台在 <code className="font-mono text-amber-300">/dashboard/cf</code> 维护的高质量入口，免去每个源手工维护的繁琐。</p>
              <p>• <strong className="text-white/85">真实节点测速：</strong>每条线路点击「测速」，将直接用该 IP 替换当前源节点并测试真实握手与连通率，并非虚假的 TCP ping。</p>
              <p>• <strong className="text-white/85">单源专属覆盖：</strong>支持直接粘贴批量文本（一行一个，支持 <code className="font-mono text-amber-300">IP#备注</code>），自动识别归类线路。</p>
            </div>
          </HelpPopover>
          <Switch
            checked={enabled}
            onCheckedChange={(next) => updateConfig({ enabled: next })}
            aria-label="开启 CF 优选加速"
            className="data-[state=checked]:bg-amber-500"
          />
        </div>
      </div>

      {enabled && (
        <div className="mt-3 space-y-2.5 border-t border-white/10 pt-3 animate-in fade-in-50 duration-200">
          <div className="flex flex-col gap-1.5 sm:flex-row">
            <div className="grid flex-1 grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/40 p-0.5">
              <button
                type="button"
                onClick={() => updateConfig({ strategy: "platform" })}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                  currentStrategy === "platform"
                    ? "bg-amber-500/20 text-amber-200 border border-amber-500/30"
                    : "text-white/50 hover:bg-white/5 hover:text-white/80",
                )}
              >
                继承平台入口池
              </button>
              <button
                type="button"
                onClick={() => updateConfig({ strategy: "custom" })}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                  currentStrategy === "custom"
                    ? "bg-amber-500/20 text-amber-200 border border-amber-500/30"
                    : "text-white/50 hover:bg-white/5 hover:text-white/80",
                )}
              >
                单源专属覆盖
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/40 p-0.5 sm:w-[250px]">
              <button
                type="button"
                onClick={() => updateConfig({ mode: "clone" })}
                title="原节点保留，按勾选线路额外衍生加速节点"
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                  currentMode === "clone"
                    ? "bg-amber-500/20 text-amber-200 border border-amber-500/30"
                    : "text-white/50 hover:bg-white/5 hover:text-white/80",
                )}
              >
                生成优选副本
              </button>
              <button
                type="button"
                onClick={() => updateConfig({ mode: "replace" })}
                title="不增加节点数量，直接替换原入口"
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                  currentMode === "replace"
                    ? "bg-amber-500/20 text-amber-200 border border-amber-500/30"
                    : "text-white/50 hover:bg-white/5 hover:text-white/80",
                )}
              >
                直接替换原入口
              </button>
            </div>
          </div>

          {/* ======================================================== */}
          {/* 3A: 继承平台入口池视图 */}
          {/* ======================================================== */}
          {currentStrategy === "platform" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-[11px] text-white/50">
                  {loadingPool
                    ? "加载平台池..."
                    : `${isPlatformActive ? "" : "未开启 · "}已选 ${platformSelected.length} / ${platformEntries.length}`}
                  <a
                    href="/dashboard/cf"
                    target="_blank"
                    className="ml-2 text-amber-300 hover:text-amber-200 hover:underline"
                  >
                    管理 ↗
                  </a>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px] border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 gap-1"
                    onClick={handleBatchProbePlatform}
                  >
                    <Rocket className="h-3 w-3 text-amber-300" />
                    测速已选
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-white/60 hover:text-white"
                    onClick={handleSelectAllPlatform}
                  >
                    全选
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-white/60 hover:text-white"
                    onClick={handleClearAllPlatform}
                  >
                    全不选
                  </Button>
                </div>
              </div>

              <div className="max-h-[min(420px,50vh)] space-y-2 overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-2 custom-scrollbar">
                  {CF_PREFERRED_CARRIERS.map((carrierKey) => {
                    const entries = platformGroupedEntries[carrierKey];
                    if (entries.length === 0) return null;
                    const meta = CARRIER_BADGES[carrierKey];
                    const groupAddrs = entries.map((entry) => entry.address);
                    const groupSelected = groupAddrs.filter((addr) => platformSelected.includes(addr)).length;
                    const groupAll = groupAddrs.length > 0 && groupSelected === groupAddrs.length;
                    const groupSome = groupSelected > 0 && !groupAll;

                    return (
                      <div key={carrierKey} className="space-y-0.5">
                        <label className="flex cursor-pointer items-center gap-1.5 px-1 py-0.5 text-[11px]">
                          <input
                            type="checkbox"
                            checked={groupAll}
                            ref={(el) => {
                              if (el) el.indeterminate = groupSome;
                            }}
                            onChange={() => handleToggleGroupPlatform(groupAddrs)}
                            className="h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-white/10 text-amber-500 focus:ring-0"
                            aria-label={`${CF_PREFERRED_CARRIER_LABELS[carrierKey]} 分组全选`}
                          />
                          <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                          <span className="font-medium text-white/70">
                            {CF_PREFERRED_CARRIER_LABELS[carrierKey]}
                          </span>
                          <span className="text-white/30">{groupSelected}/{entries.length}</span>
                        </label>

                        <div className="space-y-0.5">
                          {entries.map((entry) => {
                            const isChecked = platformSelected.includes(entry.address);
                            const probe = probeMap[entry.address];

                            return (
                              <div
                                key={entry.id}
                                className={cn(
                                  "flex items-center justify-between gap-2 rounded-md px-2 py-1 transition",
                                  isChecked
                                    ? "bg-amber-500/[0.08]"
                                    : "hover:bg-white/[0.03]",
                                  !entry.enabled && "opacity-50",
                                )}
                              >
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => toggleAddressSelected(entry.address)}
                                    className="h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-white/10 text-amber-500 focus:ring-0"
                                  />
                                  <span className="truncate font-mono text-xs text-white">
                                    {entry.address}
                                  </span>
                                  {entry.pop ? (
                                    <span className="truncate text-[10px] text-white/35">{entry.pop}</span>
                                  ) : null}
                                </label>

                                <div className="flex items-center gap-2.5 shrink-0">
                                  {/* 测速结果显示 */}
                                  <div className="text-right font-mono text-xs">
                                    {probe?.loading ? (
                                      <span className="text-[10px] text-amber-300 animate-pulse">测速中...</span>
                                    ) : probe?.ms !== undefined ? (
                                      probe.ms === null ? (
                                        <span className="text-rose-300 text-[10px]">失败</span>
                                      ) : (
                                        <div>
                                          <span className="font-semibold text-emerald-400">{probe.ms}ms</span>
                                          {typeof probe.ok === "number" && (
                                            <div className="text-[9px] text-white/40 font-sans">
                                              {probe.ok}/{probe.total}通
                                            </div>
                                          )}
                                        </div>
                                      )
                                    ) : entry.ms !== undefined ? (
                                      <span className="text-white/50 text-[11px]">{entry.ms}ms</span>
                                    ) : (
                                      <span className="text-white/25 text-[10px]">未测</span>
                                    )}
                                  </div>

                                  {/* 单线路真实测速按钮 */}
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={probe?.loading}
                                    className="h-6 px-2 text-[10px] border-white/15 bg-white/5 hover:bg-amber-500/20 hover:border-amber-500/40 hover:text-amber-200 text-white/70 gap-1"
                                    onClick={() => void runSingleProbe(entry.address)}
                                    title="真实替换该源节点后进行延迟测试"
                                  >
                                    {probe?.loading ? (
                                      <Loader2 className="h-2.5 w-2.5 animate-spin text-amber-300" />
                                    ) : (
                                      <Rocket className="h-2.5 w-2.5 text-amber-400" />
                                    )}
                                    <span>测速</span>
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {platformEntries.length === 0 && (
                    <div className="py-6 text-center text-xs text-white/30">
                      平台池暂无入口，请先去「管理」添加。
                    </div>
                  )}
                </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* 3B: 单源专属覆盖视图 (批量文本解析 + 独立测速管理) */}
          {/* ======================================================== */}
          {currentStrategy === "custom" && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="cfp-batch-custom-text" className="block text-[11px] font-medium text-white/70">
                    批量添加线路 IP
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px] text-amber-300 hover:text-amber-200"
                    onClick={() => setRawBatchText(SAMPLE_BATCH_TEXT)}
                  >
                    载入示例数据
                  </Button>
                </div>
                <Textarea
                  id="cfp-batch-custom-text"
                  value={rawBatchText}
                  onChange={(e) => setRawBatchText(e.target.value)}
                  rows={4}
                  className="font-mono text-xs min-h-[90px]"
                  placeholder={`104.17.152.57#CF 电信优选\n8.35.211.74#CF 联通优选\n188.164.248.186#CF 移动优选\n172.66.2.44#三网优化`}
                />
                <div className="flex items-center justify-between pt-0.5">
                  <span className="text-[10px] text-white/40 font-mono">
                    {rawBatchText.trim()
                      ? `已识别 ${parseCfPreferredBatchLines(rawBatchText).length} 条有效线路`
                      : "支持粘贴 IP#备注，一行一个"}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-white/50 hover:text-white"
                      onClick={() => setRawBatchText("")}
                    >
                      清空文本
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!rawBatchText.trim()}
                      className="h-6 px-3 text-[11px] border border-amber-500/50 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"
                      onClick={handleParseAndAppend}
                    >
                      批量解析并追加
                    </Button>
                  </div>
                </div>
              </div>

              {/* 解析后自定义线路列表 */}
              <div className="space-y-2 pt-1 border-t border-white/10">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-medium text-white/80">专属自定义线路列表</span>
                    <span className="text-[11px] text-amber-300 font-mono ml-1.5">
                      （{customLines.length} 条已解析）
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={customLines.length === 0}
                      className="h-6 px-2 text-[11px] border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 gap-1"
                      onClick={handleBatchProbeCustom}
                    >
                      <Rocket className="h-3 w-3 text-amber-300" />
                      <span>一键测速全部</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={customLines.length === 0}
                      className="h-6 px-2 text-[11px] text-rose-300/80 hover:text-rose-200"
                      onClick={() => updateConfig({ customLines: [], addresses: [] })}
                    >
                      清空列表
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5 rounded-xl border border-white/10 bg-black/40 p-2.5 max-h-[280px] overflow-y-auto custom-scrollbar">
                  {customLines.map((item) => {
                    const isChecked = selectedAddresses.includes(item.address);
                    const carrierKey = item.carrier ?? "global";
                    const meta = CARRIER_BADGES[carrierKey];
                    const probe = probeMap[item.address];

                    return (
                      <div
                        key={item.address}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-md px-2 py-1 transition",
                          isChecked ? "bg-amber-500/[0.08]" : "hover:bg-white/[0.03]",
                        )}
                      >
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleAddressSelected(item.address)}
                            className="h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-white/10 text-amber-500 focus:ring-0"
                          />
                          <span className="truncate font-mono text-xs text-white">{item.address}</span>
                          <span className={cn("shrink-0 rounded border px-1 text-[9px]", meta.badge)}>
                            {CF_PREFERRED_CARRIER_LABELS[carrierKey]}
                          </span>
                          {item.label ? (
                            <span className="truncate text-[10px] text-white/35">{item.label}</span>
                          ) : null}
                        </label>

                        <div className="flex items-center gap-2.5 shrink-0">
                          {/* 测速结果显示 */}
                          <div className="text-right font-mono text-xs">
                            {probe?.loading ? (
                              <span className="text-[10px] text-amber-300 animate-pulse">测速中...</span>
                            ) : probe?.ms !== undefined ? (
                              probe.ms === null ? (
                                <span className="text-rose-300 text-[10px]">失败</span>
                              ) : (
                                <div>
                                  <span className="font-semibold text-emerald-400">{probe.ms}ms</span>
                                  {typeof probe.ok === "number" && (
                                    <div className="text-[9px] text-white/40 font-sans">
                                      {probe.ok}/{probe.total}通
                                    </div>
                                  )}
                                </div>
                              )
                            ) : (
                              <span className="text-white/25 text-[10px]">未测</span>
                            )}
                          </div>

                          {/* 单线测速按钮 */}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={probe?.loading}
                            className="h-6 px-2 text-[10px] border-white/15 bg-white/5 hover:bg-amber-500/20 hover:border-amber-500/40 hover:text-amber-200 text-white/70 gap-1"
                            onClick={() => void runSingleProbe(item.address)}
                            title="真实替换该源节点后进行延迟测试"
                          >
                            {probe?.loading ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin text-amber-300" />
                            ) : (
                              <Rocket className="h-2.5 w-2.5 text-amber-400" />
                            )}
                            <span>测速</span>
                          </Button>

                          {/* 删除条目按钮 */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-white/30 hover:text-rose-300"
                            onClick={() => handleDeleteCustomLine(item.address)}
                            title="删除该线路"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}

                  {customLines.length === 0 && (
                    <div className="py-6 text-center text-xs text-white/30">
                      暂无自定义线路，请在上方文本框粘贴并点击「批量解析并追加」。
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
