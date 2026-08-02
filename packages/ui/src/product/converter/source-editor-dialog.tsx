"use client";

import * as React from "react";
import { HelpCircle } from "lucide-react";
import { DEFAULT_NODE_NAME_TEMPLATE } from "@subboost/core/node-name-template";
import {
  DEFAULT_HEALTH_CHECK,
  HEALTH_CHECK_CONCURRENCY_MAX,
  HEALTH_CHECK_CONCURRENCY_MIN,
  HEALTH_CHECK_MAX_DELAY_MAX_MS,
  HEALTH_CHECK_MAX_DELAY_MIN_MS,
  normalizeHealthCheckUrl,
  type SourceHealthCheckConfig,
} from "@subboost/core/subscription/node-health";
import { Button } from "@subboost/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@subboost/ui/components/ui/dialog";
import { FormField } from "@subboost/ui/components/ui/form-field";
import { HelpPopover } from "@subboost/ui/components/ui/popover";
import { Input } from "@subboost/ui/components/ui/input";
import { Switch } from "@subboost/ui/components/ui/switch";
import { Textarea } from "@subboost/ui/components/ui/textarea";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import { sourceTypeInfo } from "./source-type-info";

export type SourceEditorDialogProps = {
  source: SubscriptionSource | null;
  previewName: string;
  onClose: () => void;
  onUpdateContent: (id: string, content: string) => void;
  onUpdateMeta: (id: string, patch: Partial<SubscriptionSource>) => void;
};

function parseBoundedInt(raw: string, min: number, max: number): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/** 高级弹窗内的自动测活设置区（proxy-providers 模式不显示）。 */
function HealthCheckSettings({
  source,
  onUpdateMeta,
}: {
  source: SubscriptionSource;
  onUpdateMeta: (id: string, patch: Partial<SubscriptionSource>) => void;
}) {
  const isProviderMode = source.type === "url" && Boolean(source.useProxyProviders);
  const config = source.healthCheck;
  const [urlDraft, setUrlDraft] = React.useState<string | null>(null);
  const [urlError, setUrlError] = React.useState<string | null>(null);
  const [delayDraft, setDelayDraft] = React.useState<string | null>(null);
  const [delayError, setDelayError] = React.useState<string | null>(null);
  const [concurrencyDraft, setConcurrencyDraft] = React.useState<string | null>(null);
  const [concurrencyError, setConcurrencyError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setUrlDraft(null);
    setUrlError(null);
    setDelayDraft(null);
    setDelayError(null);
    setConcurrencyDraft(null);
    setConcurrencyError(null);
  }, [source.id]);

  if (isProviderMode) {
    return (
      <p className="text-[11px] text-white/40">
        proxy-providers 模式节点由客户端拉取，无法在 SubBoost 内测活，自动测活已禁用。
      </p>
    );
  }

  const updateConfig = (patch: Partial<SourceHealthCheckConfig>) => {
    onUpdateMeta(source.id, { healthCheck: { ...(config ?? {}), ...patch } });
  };

  const commitUrl = (raw: string) => {
    const normalized = normalizeHealthCheckUrl(raw);
    if (!normalized) {
      setUrlError("仅支持 HTTP/HTTPS 测活 URL");
      setUrlDraft(null);
      return;
    }
    setUrlError(null);
    setUrlDraft(null);
    if (normalized !== (config?.url ?? "")) updateConfig({ url: normalized });
  };

  const commitDelay = (raw: string) => {
    const value = parseBoundedInt(raw, HEALTH_CHECK_MAX_DELAY_MIN_MS, HEALTH_CHECK_MAX_DELAY_MAX_MS);
    if (value === null) {
      setDelayError(`最高延迟需为 ${HEALTH_CHECK_MAX_DELAY_MIN_MS}-${HEALTH_CHECK_MAX_DELAY_MAX_MS}ms 的整数`);
      setDelayDraft(null);
      return;
    }
    setDelayError(null);
    setDelayDraft(null);
    if (value !== config?.maxDelayMs) updateConfig({ maxDelayMs: value });
  };

  const commitConcurrency = (raw: string) => {
    const value = parseBoundedInt(raw, HEALTH_CHECK_CONCURRENCY_MIN, HEALTH_CHECK_CONCURRENCY_MAX);
    if (value === null) {
      setConcurrencyError(`并发需为 ${HEALTH_CHECK_CONCURRENCY_MIN}-${HEALTH_CHECK_CONCURRENCY_MAX} 的整数`);
      setConcurrencyDraft(null);
      return;
    }
    setConcurrencyError(null);
    setConcurrencyDraft(null);
    if (value !== config?.concurrency) updateConfig({ concurrency: value });
  };

  const enabled = Boolean(config?.enabled);

  return (
    <div className="space-y-2 border-t border-white/10 pt-3">
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={(next) => updateConfig({ enabled: next })}
          aria-label="自动测活"
        />
        <span className="text-xs text-white/70">自动测活</span>
        <HelpPopover
          label="自动测活说明"
          side="bottom"
          align="end"
          contentClassName="w-[320px] bg-black/90 p-3"
        >
          <div className="space-y-2 text-xs">
            <p className="leading-relaxed text-white/60">
              开启后，保存订阅以及每次手动/定时刷新时都会用 mihomo 内核测活：只保留延迟不超过上限的节点供下游订阅使用，
              失败的节点仍会保留在“节点管理”中供查看。
            </p>
            <p className="leading-relaxed text-white/60">
              也可以随时点击源行或节点上的测活按钮立即测活，不受此开关限制。
            </p>
          </div>
        </HelpPopover>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="测活 URL">
          <Input
            value={urlDraft ?? config?.url ?? ""}
            onChange={(event) => {
              setUrlDraft(event.target.value);
              setUrlError(null);
            }}
            onBlur={(event) => commitUrl(event.currentTarget.value)}
            placeholder={DEFAULT_HEALTH_CHECK.url}
            className="text-xs font-mono"
          />
        </FormField>
        <FormField label={`最高延迟 (ms)`}>
          <Input
            value={delayDraft ?? (config?.maxDelayMs !== undefined ? String(config.maxDelayMs) : "")}
            onChange={(event) => {
              setDelayDraft(event.target.value.replace(/\D/g, ""));
              setDelayError(null);
            }}
            onBlur={(event) => commitDelay(event.currentTarget.value)}
            placeholder={String(DEFAULT_HEALTH_CHECK.maxDelayMs)}
            inputMode="numeric"
            className="text-xs"
          />
        </FormField>
        <FormField label="并发">
          <Input
            value={concurrencyDraft ?? (config?.concurrency !== undefined ? String(config.concurrency) : "")}
            onChange={(event) => {
              setConcurrencyDraft(event.target.value.replace(/\D/g, ""));
              setConcurrencyError(null);
            }}
            onBlur={(event) => commitConcurrency(event.currentTarget.value)}
            placeholder={String(DEFAULT_HEALTH_CHECK.concurrency)}
            inputMode="numeric"
            className="text-xs"
          />
        </FormField>
      </div>
      {(urlError || delayError || concurrencyError) && (
        <p className="text-[11px] text-red-400">{urlError ?? delayError ?? concurrencyError}</p>
      )}
      <p className="text-[11px] text-white/40">
        留空使用默认值：URL {DEFAULT_HEALTH_CHECK.url}、最高延迟 {DEFAULT_HEALTH_CHECK.maxDelayMs}ms、并发{" "}
        {DEFAULT_HEALTH_CHECK.concurrency}。设置会随订阅保存。
      </p>
    </div>
  );
}

export function SourceEditorDialog({
  source,
  previewName,
  onClose,
  onUpdateContent,
  onUpdateMeta,
}: SourceEditorDialogProps) {
  return (
    <Dialog open={Boolean(source)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{source ? `高级编辑：${sourceTypeInfo[source.type].label}` : "高级编辑"}</DialogTitle>
        </DialogHeader>

        {source ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="标签（tag）">
                <Input
                  value={source.tag ?? ""}
                  onChange={(event) => onUpdateMeta(source.id, { tag: event.target.value })}
                  placeholder="例如：A / 订阅1 / 自建1"
                  className="text-xs"
                />
              </FormField>
              <FormField label="节点命名模板">
                <Input
                  value={source.nameTemplate ?? DEFAULT_NODE_NAME_TEMPLATE}
                  onChange={(event) => onUpdateMeta(source.id, { nameTemplate: event.target.value })}
                  className="text-xs font-mono"
                />
              </FormField>
              <FormField label="预览">
                <Input value={previewName} readOnly className="text-xs font-mono" />
              </FormField>
            </div>

            <p className="text-[11px] text-white/40">
              可用占位符：{"{tag}"}、{"{name}"}；留空则默认：{DEFAULT_NODE_NAME_TEMPLATE}
            </p>

            <div className="space-y-1">
              <p className="text-xs text-white/60">{sourceTypeInfo[source.type].label}</p>
              {source.type === "url" ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Input
                      value={source.content}
                      onChange={(event) => onUpdateContent(source.id, event.target.value)}
                      placeholder={sourceTypeInfo[source.type].placeholder}
                      className="min-w-0 flex-1 text-xs"
                    />
                    <div className="flex h-10 flex-none items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3">
                      <span className="whitespace-nowrap text-xs text-white/70">proxy-providers模式</span>
                      <HelpPopover
                        label="proxy-providers 模式说明"
                        side="bottom"
                        align="end"
                        contentClassName="w-[360px] bg-black/90 p-3"
                      >
                        <div className="space-y-2 text-xs">
                          <div className="flex items-center gap-2">
                            <HelpCircle className="h-4 w-4 text-amber-300" aria-hidden="true" />
                            <p className="font-medium text-white">proxy-providers 模式</p>
                          </div>
                          <p className="leading-relaxed text-white/60">
                            部分订阅限制 CN IP 导入，url 无法在 SubBoost 内拉取解析。开启后 SubBoost
                            不再拉取/解析该 url，而是在最终配置中写入{" "}
                            <span className="font-mono">proxy-providers</span>，交由客户端自行拉取节点。
                          </p>
                          <div className="space-y-1 border-t border-white/10 pt-2 text-white/60">
                            <p className="font-medium text-white/80">注意开启后：</p>
                            <ul className="ml-4 list-disc space-y-1">
                              <li>无法在预览中查看/管理该 url 的节点</li>
                              <li>无法将这些节点用于中转代理组、分流组高级模式等高级功能</li>
                              <li>节点命名模板与 tag 在该模式下不生效</li>
                            </ul>
                          </div>
                          <p className="border-t border-white/10 pt-2 text-[10px] text-white/40">
                            若导入 url 报“未解析到有效节点/获取失败”等，可尝试开启此模式。
                          </p>
                        </div>
                      </HelpPopover>
                      <Switch
                        checked={Boolean(source.useProxyProviders)}
                        onCheckedChange={(checked) => onUpdateMeta(source.id, { useProxyProviders: checked })}
                        aria-label="使用 proxy-providers 模式"
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="流量/到期信息 URL（可选）">
                      <Input
                        value={source.userinfoUrl ?? ""}
                        onChange={(event) => onUpdateMeta(source.id, { userinfoUrl: event.target.value })}
                        placeholder="留空则默认使用当前订阅源 URL"
                        className="text-xs"
                      />
                    </FormField>
                    <FormField label="流量信息 User-Agent（可选）">
                      <Input
                        value={source.userinfoUserAgent ?? ""}
                        onChange={(event) => onUpdateMeta(source.id, { userinfoUserAgent: event.target.value })}
                        placeholder="例如 clash.meta/v1.19.16"
                        className="text-xs"
                      />
                    </FormField>
                  </div>
                  <p className="text-[11px] text-white/40">
                    有些订阅源不会直接返回 <span className="font-mono">subscription-userinfo</span>，但会提供独立的流量接口。
                    设置后，SubBoost 会在导入/刷新时额外抓取该接口，用来更新这个源自己的流量与到期快照。
                  </p>
                </div>
              ) : (
                <Textarea
                  value={source.content}
                  onChange={(event) => onUpdateContent(source.id, event.target.value)}
                  placeholder={sourceTypeInfo[source.type].placeholder}
                  className="min-h-[60vh] text-xs font-mono"
                />
              )}
            </div>

            <HealthCheckSettings source={source} onUpdateMeta={onUpdateMeta} />
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>完成</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
