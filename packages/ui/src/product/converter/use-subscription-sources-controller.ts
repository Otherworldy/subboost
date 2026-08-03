"use client";

import * as React from "react";
import { DEFAULT_NODE_NAME_TEMPLATE, formatNodeNameFromTemplate } from "@subboost/core/node-name-template";
import { normalizeSubscriptionImportErrorInfo } from "@subboost/core/subscription/import-error";
import type { ParsedNode } from "@subboost/core/types/node";
import { getNodeSourceIds, useConfigStore, type SourceType, type SubscriptionSource } from "@subboost/ui/store/config-store";
import { useUserStore } from "@subboost/ui/store/user-store";
import { toast } from "@subboost/ui/components/ui/toaster";
import { useProductInteractionAdapter, type ProductInteractionResult } from "@subboost/ui/product/interactions";
import { markSourceAsPendingImport } from "@subboost/ui/product/subscription/source-import-state";
import { moveSubscriptionSource, moveSubscriptionSourceTo } from "@subboost/ui/product/subscription/source-order";
import { showHealthRunOutcomeToast } from "@subboost/ui/product/converter/health-outcome";

export type SubscriptionSourcesMode = "quick" | "advanced";

type ExpandedSourceSnapshot = {
  id: string;
  content: string;
  tag: string;
  nameTemplate: string;
  useProxyProviders: boolean;
  userinfoUrl: string;
  userinfoUserAgent: string;
};

type Options = {
  mode: SubscriptionSourcesMode;
};

function createExpandedSourceSnapshot(source: SubscriptionSource): ExpandedSourceSnapshot {
  return {
    id: source.id,
    content: source.content,
    tag: (source.tag ?? "").trim(),
    nameTemplate: (source.nameTemplate ?? "").trim(),
    useProxyProviders: Boolean(source.useProxyProviders),
    userinfoUrl: (source.userinfoUrl ?? "").trim(),
    userinfoUserAgent: (source.userinfoUserAgent ?? "").trim(),
  };
}

function changedSinceSnapshot(source: SubscriptionSource, snapshot: ExpandedSourceSnapshot): boolean {
  const next = createExpandedSourceSnapshot(source);
  return (
    next.content !== snapshot.content ||
    next.tag !== snapshot.tag ||
    next.nameTemplate !== snapshot.nameTemplate ||
    next.useProxyProviders !== snapshot.useProxyProviders ||
    next.userinfoUrl !== snapshot.userinfoUrl ||
    next.userinfoUserAgent !== snapshot.userinfoUserAgent
  );
}

function sourceMetaNeedsReimport(patch: Partial<SubscriptionSource>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(patch, "tag") ||
    Object.prototype.hasOwnProperty.call(patch, "nameTemplate") ||
    Object.prototype.hasOwnProperty.call(patch, "useProxyProviders") ||
    Object.prototype.hasOwnProperty.call(patch, "userinfoUrl") ||
    Object.prototype.hasOwnProperty.call(patch, "userinfoUserAgent")
  );
}

export function useSubscriptionSourcesController({ mode }: Options) {
  const { nodes, parseErrors, sources, setSources, parseSingleSource } = useConfigStore();
  const { user } = useUserStore();
  const interactions = useProductInteractionAdapter();

  const [showAddMenu, setShowAddMenu] = React.useState(false);
  const [expandedSourceId, setExpandedSourceId] = React.useState<string | null>(null);
  const [healthCheckingSourceId, setHealthCheckingSourceId] = React.useState<string | null>(null);
  const expandedSource = React.useMemo(
    () => sources.find((source) => source.id === expandedSourceId) ?? null,
    [expandedSourceId, sources]
  );
  const [expandedSourceSnapshot, setExpandedSourceSnapshot] = React.useState<ExpandedSourceSnapshot | null>(null);

  React.useEffect(() => {
    if (!expandedSource) {
      setExpandedSourceSnapshot(null);
      return;
    }
    setExpandedSourceSnapshot((prev) => {
      if (prev?.id === expandedSource.id) return prev;
      return createExpandedSourceSnapshot(expandedSource);
    });
  }, [expandedSource]);

  React.useEffect(() => {
    if (mode !== "advanced" || sources.length > 0) return;
    setSources([{ id: "1", type: "url", content: "", nameTemplate: DEFAULT_NODE_NAME_TEMPLATE }]);
  }, [mode, setSources, sources.length]);

  const expandedSourcePreviewName = React.useMemo(() => {
    if (!expandedSource) return "";
    return formatNodeNameFromTemplate({
      originName: "节点名称",
      tag: expandedSource.tag,
      template: expandedSource.nameTemplate,
    });
  }, [expandedSource]);

  const maxSourcesPerType = React.useMemo(() => {
    if (user?.isAdmin) return Number.POSITIVE_INFINITY;
    if (!user) return 2;
    const raw = user.quota?.maxImportSourcesPerType;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5;
  }, [user]);

  const nodeCount = nodes.length;
  const error = React.useMemo(
    () => normalizeSubscriptionImportErrorInfo(parseErrors[0] ?? null)?.message ?? null,
    [parseErrors]
  );
  const nodesBySourceId = React.useMemo(() => {
    const grouped = new Map<string, ParsedNode[]>();
    for (const node of nodes) {
      for (const sourceId of getNodeSourceIds(node)) {
        const current = grouped.get(sourceId);
        if (current) {
          current.push(node);
        } else {
          grouped.set(sourceId, [node]);
        }
      }
    }
    return grouped;
  }, [nodes]);

  const closeExpandedSourceEditor = React.useCallback(() => {
    if (
      expandedSource &&
      expandedSourceSnapshot?.id === expandedSource.id &&
      !expandedSource.parsing &&
      changedSinceSnapshot(expandedSource, expandedSourceSnapshot)
    ) {
      void parseSingleSource(expandedSource.id);
    }
    setExpandedSourceId(null);
  }, [expandedSource, expandedSourceSnapshot, parseSingleSource]);

  const addSource = React.useCallback(
    (type: SourceType = "url") => {
      const used = sources.filter((source) => source.type === type).length;
      if (used >= maxSourcesPerType) {
        toast({
          title: user ? `每种导入方式最多 ${maxSourcesPerType} 个` : "未登录用户每种导入方式最多 2 个（登录后可提升）",
          variant: "warning",
        });
        setShowAddMenu(false);
        return;
      }
      const newSource: SubscriptionSource = {
        id: Date.now().toString(),
        type,
        content: "",
        nameTemplate: DEFAULT_NODE_NAME_TEMPLATE,
      };
      setSources([...sources, newSource]);
      interactions.sourceAdded?.({
        mode,
        sourceType: type,
        sourceCount: sources.length + 1,
      });
      setShowAddMenu(false);
    },
    [interactions, maxSourcesPerType, mode, setSources, sources, user]
  );

  const removeSource = React.useCallback(
    (id: string) => {
      if (sources.length <= 1) return;
      setSources(sources.filter((source) => source.id !== id));
    },
    [setSources, sources]
  );

  const updateSource = React.useCallback(
    (id: string, content: string) => {
      setSources(
        sources.map((source) => {
          if (source.id !== id) return source;
          if (source.content === content) return source;
          return markSourceAsPendingImport({ ...source, content });
        })
      );
    },
    [setSources, sources]
  );

  const updateSourceMeta = React.useCallback(
    (id: string, patch: Partial<SubscriptionSource>) => {
      setSources(
        sources.map((source) => {
          if (source.id !== id) return source;

          const next = { ...source, ...patch };
          const changed = (Object.keys(patch) as Array<keyof SubscriptionSource>).some((key) => source[key] !== next[key]);
          if (!changed) return source;

          return sourceMetaNeedsReimport(patch) ? markSourceAsPendingImport(next) : next;
        })
      );
    },
    [setSources, sources]
  );

  const moveSource = React.useCallback(
    (sourceId: string, direction: "up" | "down") => {
      const nextSources = moveSubscriptionSource(sources, sourceId, direction);
      if (nextSources === sources) return;
      setSources(nextSources);
      // 节点跟随源顺序重排
      useConfigStore.getState().reorderNodesBySources();
    },
    [setSources, sources]
  );

  // 拖拽排序：把 sourceId 移到 targetSourceId 所在位置，节点同步重排
  const moveSourceTo = React.useCallback(
    (sourceId: string, targetSourceId: string) => {
      const nextSources = moveSubscriptionSourceTo(sources, sourceId, targetSourceId);
      if (nextSources === sources) return;
      setSources(nextSources);
      useConfigStore.getState().reorderNodesBySources();
    },
    [setSources, sources]
  );

  // 拖拽过程状态：正在拖的源 + 当前悬停目标（用于高亮）
  const [dragSourceId, setDragSourceId] = React.useState<string | null>(null);
  const [dragOverSourceId, setDragOverSourceId] = React.useState<string | null>(null);
  const handleSourceDragStart = React.useCallback((sourceId: string) => setDragSourceId(sourceId), []);
  const handleSourceDragOver = React.useCallback((sourceId: string) => setDragOverSourceId(sourceId), []);
  const handleSourceDrop = React.useCallback(
    (targetSourceId: string) => {
      if (dragSourceId && dragSourceId !== targetSourceId) moveSourceTo(dragSourceId, targetSourceId);
      setDragSourceId(null);
      setDragOverSourceId(null);
    },
    [dragSourceId, moveSourceTo]
  );
  const handleSourceDragEnd = React.useCallback(() => {
    setDragSourceId(null);
    setDragOverSourceId(null);
  }, []);

  const updateSourceType = React.useCallback(
    (id: string, type: SourceType) => {
      const current = sources.find((source) => source.id === id);
      if (!current || current.type === type) return;

      const used = sources.filter((source) => source.type === type).length;
      if (used >= maxSourcesPerType) {
        toast({
          title: user ? `每种导入方式最多 ${maxSourcesPerType} 个` : "未登录用户每种导入方式最多 2 个（登录后可提升）",
          variant: "warning",
        });
        return;
      }

      setSources(
        sources.map((source) => {
          if (source.id !== id) return source;

          return markSourceAsPendingImport({
            ...source,
            type,
            content: "",
            useProxyProviders: type === "url" ? Boolean(source.useProxyProviders) : undefined,
            userinfoUrl: type === "url" ? source.userinfoUrl : undefined,
            userinfoUserAgent: type === "url" ? source.userinfoUserAgent : undefined,
            lastParsedContent: undefined,
            lastParsedTag: undefined,
            lastParsedNameTemplate: undefined,
          });
        })
      );
    },
    [maxSourcesPerType, setSources, sources, user]
  );

  const handleImportSource = React.useCallback(
    async (sourceId: string) => {
      const source = sources.find((item) => item.id === sourceId);
      if (!source || !source.content.trim() || source.parsing) return;

      await parseSingleSource(sourceId);

      const latestState = useConfigStore.getState();
      const latestSource = latestState.sources.find((item) => item.id === sourceId) ?? source;
      const result: ProductInteractionResult = latestSource.parsed
        ? "success"
        : latestSource.error || latestSource.errorInfo
          ? "runtimeError"
          : "validationError";
      interactions.sourceImported?.({
        mode,
        sourceType: latestSource.type,
        result,
        sourceCount: latestState.sources.filter((item) => item.content.trim()).length,
        nodeCount: latestSource.nodeCount ?? 0,
        usesProxyProvider: Boolean(latestSource.useProxyProviders),
      });
    },
    [interactions, mode, parseSingleSource, sources]
  );

  // 手动测活不受自动开关限制；仅需该源已解析出节点
  const handleHealthCheckSource = React.useCallback(
    async (sourceId: string) => {
      const sourceNodes = nodesBySourceId.get(sourceId) ?? [];
      if (sourceNodes.length === 0) {
        toast({ title: "该源暂无节点，请先导入后再测活", variant: "warning" });
        return;
      }
      setHealthCheckingSourceId(sourceId);
      try {
        const outcome = await useConfigStore.getState().runHealthCheck({ kind: "source", sourceId });
        showHealthRunOutcomeToast(outcome, { kind: "source", sourceId });
      } finally {
        setHealthCheckingSourceId((current) => (current === sourceId ? null : current));
      }
    },
    [nodesBySourceId]
  );

  return {
    addSource,
    closeExpandedSourceEditor,
    error,
    expandedSource,
    expandedSourcePreviewName,
    handleImportSource,
    handleHealthCheckSource,
    healthCheckingSourceId,
    maxSourcesPerType,
    moveSource,
    moveSourceTo,
    dragSourceId,
    dragOverSourceId,
    handleSourceDragStart,
    handleSourceDragOver,
    handleSourceDrop,
    handleSourceDragEnd,
    nodeCount,
    nodesBySourceId,
    removeSource,
    setExpandedSourceId,
    setShowAddMenu,
    showAddMenu,
    sources,
    updateSource,
    updateSourceMeta,
    updateSourceType,
  };
}
