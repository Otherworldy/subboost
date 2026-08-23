"use client";

import * as React from "react";
import { Check, Loader2, Rocket, Trash2, Zap } from "lucide-react";
import { MAX_CF_PREFERRED_ADDRESSES, normalizeCfPreferredAddresses } from "@subboost/core/subscription/cf-preferred";
import type { CfPreferredSourceConfig } from "@subboost/core/types/config";
import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import { Badge } from "@subboost/ui/components/ui/badge";
import { Button } from "@subboost/ui/components/ui/button";
import { HelpPopover } from "@subboost/ui/components/ui/popover";
import { Input } from "@subboost/ui/components/ui/input";
import { Switch } from "@subboost/ui/components/ui/switch";
import { cn } from "@subboost/ui/lib/utils";
import { useConfigStore, type SubscriptionSource } from "@subboost/ui/store/config-store";
import { defaultCfPreferredConfig } from "./source-cf-preferred-controls";

type CandidateNode = { name: string; status: string; delayMs?: number };
type Candidate = {
  ip: string;
  ms: number | null;
  ok?: number;
  fail?: number;
  nodes?: CandidateNode[];
};
type PreviewState = {
  loading: boolean;
  error: string | null;
  message: string | null;
  candidates: Candidate[];
};

const IDLE_PREVIEW: PreviewState = { loading: false, error: null, message: null, candidates: [] };

const API_PRESETS = [
  { label: "三网优选", url: "cf.090227.xyz", desc: "DNS 智能动态解析" },
  { label: "电信 API", url: "https://cf.090227.xyz/ct?ips=6", desc: "电信专属" },
  { label: "联通 API", url: "https://cf.090227.xyz/cu", desc: "联通专属" },
  { label: "移动 API", url: "https://cf.090227.xyz/cmcc?ips=8", desc: "移动专属" },
];

export function CfPreferredSettings({
  source,
  onUpdateMeta,
}: {
  source: SubscriptionSource;
  onUpdateMeta: (id: string, patch: Partial<SubscriptionSource>) => void;
}) {
  const config = source.cfPreferred;
  const enabled = config?.enabled === true;
  const currentMode = config?.mode ?? "clone";
  const selectedIps = normalizeCfPreferredAddresses(config?.addresses);
  const [preview, setPreview] = React.useState<PreviewState>(IDLE_PREVIEW);
  const previewAbort = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => previewAbort.current?.abort(), []);
  React.useEffect(() => {
    previewAbort.current?.abort();
    setPreview(IDLE_PREVIEW);
  }, [source.id]);

  const updateConfig = (patch: Partial<CfPreferredSourceConfig>) => {
    const nextEnabled = patch.enabled ?? enabled;
    onUpdateMeta(source.id, {
      cfPreferred: defaultCfPreferredConfig({ ...config, ...patch }, nextEnabled),
    });
  };

  async function runPreview(address: string) {
    const target = address.trim();
    if (!target) return;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreview({ ...IDLE_PREVIEW, loading: true });
    try {
      const sourceNodes = useConfigStore.getState().nodes.filter((node) => getNodeSourceIds(node).includes(source.id));
      const response = await fetch("/api/cf-preferred/preview", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: target,
          sourceId: source.id,
          nodes: sourceNodes,
          mode: currentMode,
          ...(source.healthCheck ? { healthCheck: source.healthCheck } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "preview_failed");
      setPreview({
        loading: false,
        error: null,
        message: typeof data?.message === "string" ? data.message : null,
        candidates: Array.isArray(data?.candidates)
          ? data.candidates.filter(
              (c: unknown): c is Candidate =>
                Boolean(c) &&
                typeof (c as Candidate).ip === "string" &&
                (typeof (c as Candidate).ms === "number" || (c as Candidate).ms === null),
            )
          : [],
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPreview({
        loading: false,
        error: error instanceof Error && error.message !== "preview_failed" ? error.message : "测速失败，请检查网络或地址",
        message: null,
        candidates: [],
      });
    }
  }

  const toggleIp = (ip: string) => {
    if (currentMode === "replace") {
      updateConfig({ addresses: selectedIps[0] === ip ? [] : [ip], enabled: true });
      return;
    }
    const next = selectedIps.includes(ip)
      ? selectedIps.filter((item) => item !== ip)
      : [...selectedIps, ip].slice(0, MAX_CF_PREFERRED_ADDRESSES);
    updateConfig({ addresses: next, enabled: true });
  };

  const isSelectedIp = (ip: string) => selectedIps.includes(ip);

  return (
    <div
      className={cn(
        "rounded-xl border transition-all duration-200",
        enabled
          ? "border-amber-500/30 bg-gradient-to-b from-amber-500/[0.04] to-transparent p-4 shadow-sm"
          : "border-white/10 bg-white/[0.02] p-4",
      )}
    >
      {/* 头部：图标 + 标题 + 状态徽章 + 帮助 + 开关 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
              enabled
                ? "border-amber-500/40 bg-amber-500/15 text-amber-300 shadow-sm shadow-amber-500/15"
                : "border-white/10 bg-white/5 text-white/35",
            )}
          >
            <Zap
              className={cn("h-4 w-4 transition-transform", enabled ? "fill-amber-300/40 scale-105" : "")}
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-white/90">Cloudflare 优选加速</span>
              <Badge
                variant="outline"
                className={cn(
                  "border px-1.5 py-0 text-[10px] font-medium leading-4 transition-colors",
                  enabled
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                    : "border-white/10 bg-white/5 text-white/40",
                )}
              >
                {enabled ? (currentMode === "replace" ? "直接替换原入口" : "生成优选副本") : "已停用"}
              </Badge>
            </div>
            <p className="truncate text-[11px] text-white/40">
              仅对套了 CF CDN 的节点生效（保留 SNI/Host，将入口替换为低延迟 Anycast 节点）
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <HelpPopover
            label="CF 优选说明"
            side="bottom"
            align="end"
            contentClassName="w-[320px] bg-black/95 p-3.5 border-white/15 shadow-xl text-xs space-y-2"
          >
            <div className="flex items-center gap-1.5 font-medium text-amber-300">
              <Zap className="h-3.5 w-3.5 fill-amber-300/40" />
              <span>CF 优选加速原理</span>
            </div>
            <p className="leading-relaxed text-white/70">
              适用于套了 Cloudflare CDN 的 <span className="font-mono text-white/90">VLESS / VMess / Trojan</span>（WS/gRPC 等 + TLS）节点。
            </p>
            <div className="space-y-1 rounded-md bg-white/5 p-2 text-[11px] text-white/60">
              <p>• <strong className="text-white/80">新增优选副本：</strong>保留原节点，额外生成「原名-CF」加速节点（推荐）。</p>
              <p>• <strong className="text-white/80">直接替换原节点：</strong>直接修改该源节点的连接 IP，不增加节点数量。</p>
              <p>• <strong className="text-white/80">测速与选优：</strong>用 mihomo 测「换成候选 IP 后的节点」真实延迟，不是 TCP ping。新增副本模式可勾选多个 IP（最多 {MAX_CF_PREFERRED_ADDRESSES} 个）。</p>
              <p>• <strong className="text-white/80">API 自动跟随：</strong>填入 API 地址时，每次订阅刷新/下载会自动拉取最新最优 IP。</p>
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

      {/* 展开配置面板 */}
      {enabled && (
        <div className="mt-4 space-y-3.5 border-t border-white/10 pt-3.5 animate-in fade-in-50 duration-200">
          {/* 模式选择卡片 */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-white/60">加速模式</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => updateConfig({ mode: "clone" })}
                className={cn(
                  "group relative flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all",
                  currentMode === "clone"
                    ? "border-amber-500/50 bg-amber-500/10 text-white shadow-sm ring-1 ring-amber-500/30"
                    : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:bg-white/5 hover:text-white/80",
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-white">新增优选副本</span>
                    <span className="rounded bg-amber-400/20 px-1 py-0.2 text-[9px] font-semibold text-amber-300">
                      推荐
                    </span>
                  </div>
                  {currentMode === "clone" && (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-black">
                      <Check className="h-2.5 w-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-white/45 group-hover:text-white/60">
                  原节点原样保留，按勾选的优选 IP 各生成一条「-CF」副本。
                </p>
              </button>

              <button
                type="button"
                onClick={() => updateConfig({ mode: "replace" })}
                className={cn(
                  "group relative flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all",
                  currentMode === "replace"
                    ? "border-amber-500/50 bg-amber-500/10 text-white shadow-sm ring-1 ring-amber-500/30"
                    : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:bg-white/5 hover:text-white/80",
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-xs font-semibold text-white">直接替换原入口</span>
                  {currentMode === "replace" && (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-black">
                      <Check className="h-2.5 w-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-white/45 group-hover:text-white/60">
                  直接将该源内套 CF 节点的入口改为优选 IP，节点名称和数量保持不变。
                </p>
              </button>
            </div>
          </div>

          {/* 优选地址与测速入口 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-white/60">优选入口（域名 / IP / 动态 API）</span>
              {selectedIps.length > 0 ? (
                <span className="text-[10px] text-amber-300/80">已选用 {selectedIps.length}/{MAX_CF_PREFERRED_ADDRESSES} 个入口</span>
              ) : config?.address && /^https?:\/\//i.test(config.address) ? (
                <span className="text-[10px] text-amber-300/80 font-mono">⚡ 订阅刷新时将自动拉取最优 IP</span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  value={config?.address ?? ""}
                  onChange={(event) => updateConfig({ address: event.target.value })}
                  placeholder="例如 cf.090227.xyz 或 https://cf.090227.xyz/ct?ips=6"
                  className="h-9 border-white/10 bg-black/40 font-mono text-xs text-white placeholder:text-white/30 focus:border-amber-500/50 focus:ring-amber-500/20"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  "h-9 shrink-0 gap-1.5 border-white/15 px-3 text-xs font-medium transition-colors",
                  preview.loading
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                    : "bg-white/5 text-white/80 hover:bg-white/10 hover:text-white",
                )}
                onClick={() => void runPreview(config?.address?.trim() || API_PRESETS[0].url)}
                disabled={preview.loading}
              >
                {preview.loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-300" />
                ) : (
                  <Rocket className="h-3.5 w-3.5 text-amber-300" />
                )}
                <span>{preview.loading ? "测速中..." : "测速与选优"}</span>
              </Button>
            </div>
            {selectedIps.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {selectedIps.map((ip) => (
                  <button
                    key={ip}
                    type="button"
                    title="取消选用"
                    onClick={() => toggleIp(ip)}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] text-amber-200 hover:bg-amber-500/20"
                  >
                    <span>{ip}</span>
                    <span className="text-amber-300/70">×</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="text-[11px] text-white/35 hover:text-white/70"
                  onClick={() => updateConfig({ addresses: [], enabled: true })}
                >
                  清空选用
                </button>
              </div>
            )}
          </div>

          {/* 快捷预设源 */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-white/40 mr-1">快捷预设:</span>
              {API_PRESETS.map((preset) => {
                const isSelected = (config?.address?.trim() || "cf.090227.xyz") === preset.url;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-all",
                      isSelected
                        ? "border-amber-500/50 bg-amber-500/15 text-amber-200 font-medium shadow-sm"
                        : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:bg-white/[0.08] hover:text-white",
                    )}
                    onClick={() => {
                      updateConfig({ address: preset.url, enabled: true });
                      void runPreview(preset.url);
                    }}
                  >
                    <span>{preset.label}</span>
                    <span className="text-[10px] text-white/35 font-normal">({preset.desc})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 测速结果嵌入面板 */}
          {preview.error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200 flex items-center justify-between">
              <span>{preview.error}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-rose-300 hover:bg-rose-500/20"
                onClick={() => setPreview(IDLE_PREVIEW)}
              >
                关闭
              </Button>
            </div>
          )}

          {!preview.error && preview.message && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              {preview.message}
            </div>
          )}

          {preview.candidates.length > 0 && (
            <div className="space-y-2 rounded-xl border border-white/10 bg-black/40 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-white/70">
                  <span className="font-medium text-white">优选节点测速结果</span>
                  <span className="text-[11px] text-white/40">
                    （已测 {preview.candidates.length} 个入口，按延迟排序，副本模式可多选）
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-white/40 hover:text-white/70"
                  onClick={() => setPreview(IDLE_PREVIEW)}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  清空结果
                </Button>
              </div>

              <div className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.02]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[#161616] text-white/50 shadow-sm">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">IP 地址</th>
                      <th className="px-3 py-2 text-right font-medium">优选节点延迟</th>
                      <th className="px-3 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {preview.candidates.map((c, i) => {
                      const isCurrent = isSelectedIp(c.ip);
                      const isFastest = i === 0 && c.ms !== null;
                      const selectionFull =
                        currentMode !== "replace" &&
                        !isCurrent &&
                        selectedIps.length >= MAX_CF_PREFERRED_ADDRESSES;
                      return (
                        <tr
                          key={c.ip}
                          className={cn(
                            "transition-colors hover:bg-white/[0.04]",
                            isCurrent ? "bg-amber-500/10" : "",
                          )}
                        >
                          <td className="px-3 py-2 font-mono text-white/90">
                            <div className="flex items-center gap-1.5">
                              <span>{c.ip}</span>
                              {isFastest && (
                                <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-semibold text-emerald-300">
                                  最快
                                </span>
                              )}
                              {isCurrent && (
                                <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[9px] font-semibold text-amber-300">
                                  已选用
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {c.ms === null ? (
                              <span className="text-white/30">全部失败</span>
                            ) : c.ms < 60 ? (
                              <span className="font-semibold text-emerald-400">{c.ms} ms</span>
                            ) : c.ms < 150 ? (
                              <span className="text-amber-300">{c.ms} ms</span>
                            ) : (
                              <span className="text-white/60">{c.ms} ms</span>
                            )}
                            {typeof c.ok === "number" && (c.nodes?.length ?? 0) > 0 ? (
                              <div className="mt-0.5 text-[10px] font-sans text-white/35">
                                {c.ok}/{c.nodes!.length} 通
                              </div>
                            ) : null}
                            {(c.nodes ?? []).length > 0 ? (
                              <div className="mt-1 space-y-0.5 text-[10px] font-sans text-white/40">
                                {(c.nodes ?? []).slice(0, 6).map((node) => (
                                  <div key={node.name} className="truncate" title={node.name}>
                                    <span className="text-white/50">{node.name}</span>{" "}
                                    {node.status === "ok" && typeof node.delayMs === "number"
                                      ? `${node.delayMs}ms`
                                      : node.status === "unsupported"
                                        ? "不支持"
                                        : "失败"}
                                  </div>
                                ))}
                                {(c.nodes?.length ?? 0) > 6 ? (
                                  <div>等 {c.nodes!.length - 6} 个节点</div>
                                ) : null}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              type="button"
                              variant={isCurrent ? "outline" : "secondary"}
                              size="sm"
                              className={cn(
                                "h-6 px-2.5 text-[11px] font-medium transition-all",
                                isCurrent
                                  ? "border-amber-500/40 text-amber-300 bg-amber-500/10 hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-500/30"
                                  : "bg-white/10 hover:bg-emerald-500/20 hover:text-emerald-300 hover:border-emerald-500/30 text-white/80",
                              )}
                              onClick={() => toggleIp(c.ip)}
                              disabled={selectionFull}
                            >
                              {isCurrent ? "取消" : selectionFull ? "已满" : currentMode === "replace" ? "使用此 IP" : "选用"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
