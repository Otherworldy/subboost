"use client";

import * as React from "react";
import { FileText, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { isCfPreferredApiUrl } from "@subboost/core/subscription/cf-preferred";
import {
  DEFAULT_CF_PREFERRED_POOL,
  parseCfPreferredBatchLines,
} from "@subboost/core/subscription/cf-preferred-pool";
import type {
  CfPreferredCarrier,
  CfPreferredMode,
  CfPreferredPoolConfig,
  CfPreferredPoolEntry,
} from "@subboost/core/types/config";
import {
  CF_PREFERRED_CARRIER_LABELS,
  CF_PREFERRED_CARRIERS,
} from "@subboost/core/types/config";
import { Badge } from "@subboost/ui/components/ui/badge";
import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent } from "@subboost/ui/components/ui/card";
import { ChoiceChip, ChoiceGroup } from "@subboost/ui/components/ui/choice-group";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@subboost/ui/components/ui/dialog";
import { Input } from "@subboost/ui/components/ui/input";
import { Textarea } from "@subboost/ui/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@subboost/ui/components/ui/select";
import { Switch } from "@subboost/ui/components/ui/switch";
import { toast } from "@subboost/ui/components/ui/toaster";
import { cn } from "@subboost/ui/lib/utils";

export type CfPreferredPoolAdapter = {
  fetchPool: () => Promise<{ pool: CfPreferredPoolConfig; subscriptionCount: number }>;
  savePool: (pool: CfPreferredPoolConfig) => Promise<CfPreferredPoolConfig>;
  probePool: (entryId?: string) => Promise<CfPreferredPoolConfig>;
  resolveAddress: (address: string) => Promise<{ ip: string; ms: number | null }[]>;
};

const CARRIER_TONE: Record<CfPreferredCarrier, string> = {
  optimized: "text-indigo-300",
  telecom: "text-sky-400",
  unicom: "text-orange-400",
  mobile: "text-emerald-400",
  global: "text-zinc-300",
};

type CarrierFilter = "all" | CfPreferredCarrier;
type DraftEntry = {
  address: string;
  carrier: CfPreferredCarrier;
  pop: string;
  editingId?: string;
};

const EMPTY_DRAFT: DraftEntry = { address: "", carrier: "optimized", pop: "" };

function avgMs(entries: CfPreferredPoolEntry[]): number | null {
  const values = entries.filter((e) => e.enabled && typeof e.ms === "number").map((e) => e.ms as number);
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function CfPreferredPoolSurface({ adapter }: { adapter: CfPreferredPoolAdapter }) {
  const [pool, setPool] = React.useState<CfPreferredPoolConfig>({ ...DEFAULT_CF_PREFERRED_POOL, entries: [] });
  const [subscriptionCount, setSubscriptionCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [probing, setProbing] = React.useState(false);
  const [probingId, setProbingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [carrier, setCarrier] = React.useState<CarrierFilter>("all");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<DraftEntry>(EMPTY_DRAFT);
  const [batchDialogOpen, setBatchDialogOpen] = React.useState(false);
  const [batchText, setBatchText] = React.useState("");
  const [batchFallbackCarrier, setBatchFallbackCarrier] = React.useState<CfPreferredCarrier>("optimized");

  const persist = React.useCallback(
    async (next: CfPreferredPoolConfig) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await adapter.savePool(next);
        setPool(saved);
        return saved;
      } catch (err) {
        const message = err instanceof Error ? err.message : "保存失败";
        setError(message);
        toast({ title: message, variant: "destructive" });
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [adapter],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await adapter.fetchPool();
        if (controller.signal.aborted) return;
        setPool(data.pool);
        setSubscriptionCount(data.subscriptionCount);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [adapter]);

  const filtered = carrier === "all" ? pool.entries : pool.entries.filter((e) => e.carrier === carrier);
  const enabledCount = pool.entries.filter((e) => e.enabled).length;
  const rtt = avgMs(pool.entries);

  const patchPool = (patch: Partial<CfPreferredPoolConfig>) => void persist({ ...pool, ...patch });

  const upsertEntry = async (entry: CfPreferredPoolEntry) => {
    const nextEntries = draft.editingId
      ? pool.entries.map((item) => (item.id === draft.editingId ? { ...item, ...entry, id: item.id } : item))
      : [...pool.entries.filter((item) => item.address !== entry.address), entry];
    await persist({ ...pool, entries: nextEntries });
  };

  const removeEntry = async (id: string) => {
    const ok = await confirmDialog({
      title: "移除入口？",
      description: "从列表删除后，下次订阅生成不再使用该 IP。",
      confirmText: "移除",
      variant: "destructive",
    });
    if (!ok) return;
    await persist({ ...pool, entries: pool.entries.filter((item) => item.id !== id) });
  };

  const handleBatchImport = async () => {
    const parsed = parseCfPreferredBatchLines(batchText, batchFallbackCarrier);
    if (parsed.length === 0) {
      toast({ title: "未能解析到有效入口", description: "请检查每行是否有有效 IP 或域名", variant: "destructive" });
      return;
    }
    const nextEntries = [...pool.entries];
    const seen = new Set(pool.entries.map((e) => e.address.toLowerCase()));
    let added = 0;
    for (const item of parsed) {
      if (seen.has(item.address.toLowerCase())) continue;
      seen.add(item.address.toLowerCase());
      nextEntries.push({
        id: `cfp-${item.carrier}-${item.address.replace(/[^a-zA-Z0-9]+/g, "-")}`.slice(0, 80),
        address: item.address,
        carrier: item.carrier,
        enabled: true,
        pop: item.label ? item.label.slice(0, 32) : undefined,
      });
      added++;
    }
    if (added === 0) {
      toast({ title: "没有新入口可添加", description: "解析出的入口已全部存在", variant: "warning" });
      return;
    }
    await persist({ ...pool, entries: nextEntries });
    toast({ title: `成功导入 ${added} 个入口`, variant: "success" });
    setBatchDialogOpen(false);
    setBatchText("");
  };

  const setEnabled = (id: string, enabled: boolean) => {
    void persist({
      ...pool,
      entries: pool.entries.map((item) => (item.id === id ? { ...item, enabled } : item)),
    });
  };

  const handleProbe = async () => {
    setProbing(true);
    setError(null);
    try {
      const next = await adapter.probePool();
      setPool(next);
      toast({ title: next.lastProbe?.message || "探活完成", variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "探活失败";
      setError(message);
      toast({ title: message, variant: "destructive" });
    } finally {
      setProbing(false);
    }
  };

  const handleSingleProbe = async (entryId: string) => {
    setProbingId(entryId);
    setError(null);
    try {
      const next = await adapter.probePool(entryId);
      setPool(next);
      toast({ title: "单节点测速完成", variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "测速失败";
      setError(message);
      toast({ title: message, variant: "destructive" });
    } finally {
      setProbingId(null);
    }
  };

  const submitDraft = async () => {
    const address = draft.address.trim();
    if (!address) return;
    setSaving(true);
    try {
      if (isCfPreferredApiUrl(address) && !draft.editingId) {
        const candidates = await adapter.resolveAddress(address);
        const reachable = candidates.filter((c) => c.ms !== null).map((c) => c.ip);
        const ips = reachable.length > 0 ? reachable : candidates.map((c) => c.ip);
        if (ips.length === 0) throw new Error("未能从该地址解析出公网 IP");
        const existing = new Set(pool.entries.map((e) => e.address));
        const added: CfPreferredPoolEntry[] = [];
        for (const ip of ips) {
          if (existing.has(ip)) continue;
          added.push({
            id: `cfp-${draft.carrier}-${ip.replace(/[^a-zA-Z0-9]+/g, "-")}`,
            address: ip,
            carrier: draft.carrier,
            enabled: true,
            ...(draft.pop.trim() ? { pop: draft.pop.trim() } : {}),
            ms: candidates.find((c) => c.ip === ip)?.ms ?? null,
          });
          existing.add(ip);
        }
        await persist({ ...pool, entries: [...pool.entries, ...added] });
      } else {
        const existing = draft.editingId ? pool.entries.find((item) => item.id === draft.editingId) : undefined;
        const entry: CfPreferredPoolEntry = {
          id: draft.editingId || `cfp-${draft.carrier}-${address.replace(/[^a-zA-Z0-9]+/g, "-")}`,
          address,
          carrier: draft.carrier,
          enabled: existing?.enabled ?? true,
          ...(draft.pop.trim() ? { pop: draft.pop.trim() } : {}),
          ...(existing?.ms !== undefined ? { ms: existing.ms } : {}),
          ...(existing?.probedAt ? { probedAt: existing.probedAt } : {}),
        };
        await upsertEntry(entry);
      }
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
      toast({ title: "已写入入口列表", variant: "success" });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "添加失败", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container mx-auto space-y-6 px-4 py-8">
      <div className="flex flex-col gap-4 border-b border-white/10 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Cloudflare 平台级入口加速</h1>
            <Badge variant="outline" className="font-mono text-[10px]">
              Platform Pool
            </Badge>
          </div>
          <p className="mt-1 text-sm text-white/50">
            统一维护一份优选 IP 列表，测速后注入所有订阅。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
            <span className="text-xs text-white/60">平台池</span>
            <Switch
              checked={pool.enabled}
              disabled={loading || saving}
              onCheckedChange={(enabled) => void patchPool({ enabled })}
              aria-label="开启平台级 CF 入口池"
            />
          </div>
          <Button variant="outline" size="sm" disabled={loading || probing} onClick={() => void handleProbe()}>
            <RefreshCw className={cn("h-3.5 w-3.5", probing && "animate-spin")} />
            {probing ? "全网探活中..." : "立即全网探活"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => {
              setBatchText("");
              setBatchDialogOpen(true);
            }}
          >
            <FileText className="h-3.5 w-3.5" />
            批量导入
          </Button>
          <Button
            size="sm"
            disabled={loading}
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            新增入口
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-4 text-xs leading-relaxed text-white/70">
        开启后，已启用的入口会注入所有订阅的套 CF 节点。源上勾选的入口仍可单独覆盖。
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="已启用" value={`${enabledCount} / ${pool.entries.length}`} hint="关闭的入口不会写入订阅" />
        <StatCard
          label="平均延迟"
          value={rtt === null ? "—" : `${rtt}ms`}
          hint={pool.enabled ? "仅统计已启用入口" : "平台池未开启"}
        />
        <StatCard label="关联订阅" value={`${subscriptionCount}`} hint="生成配置时统一注入" />
      </div>

      <ChoiceGroup label="线路筛选" className="gap-1.5">
        <ChoiceChip
          label={`全网 (${pool.entries.length})`}
          selected={carrier === "all"}
          onClick={() => setCarrier("all")}
        />
        {CF_PREFERRED_CARRIERS.map((key) => (
          <ChoiceChip
            key={key}
            label={`${CF_PREFERRED_CARRIER_LABELS[key]} (${pool.entries.filter((e) => e.carrier === key).length})`}
            selected={carrier === key}
            onClick={() => setCarrier(key)}
          />
        ))}
      </ChoiceGroup>

      <Card>
        <CardContent className="p-0">
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#141414] text-white/50">
                <tr>
                  <th className="px-4 py-3 font-medium">入口</th>
                  <th className="px-4 py-3 font-medium">线路</th>
                  <th className="px-4 py-3 font-medium">备注</th>
                  <th className="px-4 py-3 font-medium">延迟</th>
                  <th className="px-4 py-3 font-medium">启用</th>
                  <th className="px-4 py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {loading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-white/40">
                      加载中...
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-white/40">
                      还没有入口。添加 IP / CNAME，或填入优选 API 批量解析。
                    </td>
                  </tr>
                )}
                {filtered.map((entry) => (
                  <tr key={entry.id} className={cn("hover:bg-white/[0.03]", !entry.enabled && "opacity-50")}>
                    <td className="px-4 py-3 font-mono text-white/90">{entry.address}</td>
                    <td className={cn("px-4 py-3", CARRIER_TONE[entry.carrier])}>{CF_PREFERRED_CARRIER_LABELS[entry.carrier]}</td>
                    <td className="px-4 py-3 text-white/50">{entry.pop || "—"}</td>
                    <td className="px-4 py-3 font-mono">
                      {entry.ms == null ? (
                        <span className="text-white/30">未测</span>
                      ) : (
                        <span className={entry.ms < 150 ? "text-emerald-400" : "text-white/70"}>{entry.ms}ms</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Switch
                        checked={entry.enabled}
                        disabled={saving}
                        onCheckedChange={(enabled) => setEnabled(entry.id, enabled)}
                        aria-label={`${entry.enabled ? "停用" : "启用"} ${entry.address}`}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={probing || probingId === entry.id}
                          onClick={() => void handleSingleProbe(entry.id)}
                          title="对该入口单独测速"
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", probingId === entry.id && "animate-spin text-amber-300")} />
                          {probingId === entry.id ? "测速中" : "测速"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDraft({
                              address: entry.address,
                              carrier: entry.carrier,
                              pop: entry.pop ?? "",
                              editingId: entry.id,
                            });
                            setDialogOpen(true);
                          }}
                        >
                          配置
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void removeEntry(entry.id)} aria-label={`移除 ${entry.address}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-3 pt-6">
            <h2 className="text-base font-semibold">注入方式</h2>
            <p className="text-xs text-white/50">对所有套 CF CDN 的节点生效。源上勾选的入口优先于平台池。</p>
            <ChoiceGroup label="注入模式">
              <ChoiceChip
                label="新增优选副本"
                selected={pool.mode === "clone"}
                onClick={() => void patchPool({ mode: "clone" as CfPreferredMode })}
              />
              <ChoiceChip
                label="直接替换原入口"
                selected={pool.mode === "replace"}
                onClick={() => void patchPool({ mode: "replace" as CfPreferredMode })}
              />
            </ChoiceGroup>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">最近探活</h2>
              <Zap className="h-4 w-4 text-amber-300" />
            </div>
            <p className="text-xs text-white/50">{pool.lastProbe?.at ? new Date(pool.lastProbe.at).toLocaleString() : "尚无记录"}</p>
            <p className="text-xs text-white/70">{pool.lastProbe?.message || "点击「立即全网探活」对池内入口做 TCPing 443。"}</p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft.editingId ? "编辑入口" : "新增平台入口"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <label htmlFor="cfp-address" className="block text-xs text-white/50">IP / CNAME / 优选 API</label>
              <Input
                id="cfp-address"
                value={draft.address}
                onChange={(event) => setDraft((prev) => ({ ...prev, address: event.target.value }))}
                placeholder="104.16.1.1 或 https://cf.090227.xyz/ct"
                className="font-mono text-xs"
                disabled={Boolean(draft.editingId)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label htmlFor="cfp-carrier" className="block text-xs text-white/50">线路</label>
                <Select
                  value={draft.carrier}
                  onValueChange={(value) => setDraft((prev) => ({ ...prev, carrier: value as CfPreferredCarrier }))}
                >
                  <SelectTrigger id="cfp-carrier" className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[100]" style={{ zIndex: 100 }}>
                    {CF_PREFERRED_CARRIERS.map((key) => (
                      <SelectItem key={key} value={key}>
                        {CF_PREFERRED_CARRIER_LABELS[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor="cfp-pop" className="block text-xs text-white/50">备注（可选）</label>
                <Input id="cfp-pop" value={draft.pop} onChange={(event) => setDraft((prev) => ({ ...prev, pop: event.target.value }))} placeholder="CF 电信优选" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={saving || !draft.address.trim()} onClick={() => void submitDraft()}>
              {isCfPreferredApiUrl(draft.address) && !draft.editingId ? "解析并入池" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>批量导入优选入口</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-white/50 leading-relaxed">
              支持一行一个，格式：<code className="font-mono text-amber-300">IP#备注</code>（如 <code className="font-mono">104.17.152.57#CF 电信优选</code>）或纯 IP/域名，自动识别电信、联通、移动、三网。
            </p>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="cfp-batch-text" className="block text-xs text-white/50">入口列表文本</label>
                <span className="text-[11px] font-mono text-amber-300">
                  {batchText.trim()
                    ? `已识别 ${parseCfPreferredBatchLines(batchText, batchFallbackCarrier).length} 条有效入口`
                    : "支持粘贴外部测速文本"}
                </span>
              </div>
              <Textarea
                id="cfp-batch-text"
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder={`104.17.152.57#CF 电信优选\n8.35.211.74#CF 联通优选\n188.164.248.186#CF 移动优选\n172.66.2.44#三网优化\n8.35.211.40#CF 电信优选`}
                className="min-h-[140px] font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="cfp-batch-carrier" className="block text-xs text-white/50">未识别线路默认</label>
              <Select
                value={batchFallbackCarrier}
                onValueChange={(val) => setBatchFallbackCarrier(val as CfPreferredCarrier)}
              >
                <SelectTrigger id="cfp-batch-carrier" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[100]" style={{ zIndex: 100 }}>
                  {CF_PREFERRED_CARRIERS.map((key) => (
                    <SelectItem key={key} value={key} className="text-xs">
                      {CF_PREFERRED_CARRIER_LABELS[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBatchDialogOpen(false)}>取消</Button>
            <Button
              onClick={() => void handleBatchImport()}
              disabled={saving || !batchText.trim()}
            >
              {saving ? "保存中..." : "解析并导入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-white/50">{label}</p>
        <p className="mt-1 text-2xl font-bold">{value}</p>
        <p className="mt-1 text-[11px] text-white/40">{hint}</p>
      </CardContent>
    </Card>
  );
}
