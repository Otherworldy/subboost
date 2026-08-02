import type { RefreshSubscriptionResponse } from "./dashboard-types";

type RefreshToastVariant = "success" | "warning";

export type RefreshSubscriptionToast = {
  title: string;
  description?: string;
  variant: RefreshToastVariant;
};

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function buildRefreshSubscriptionSuccessToast(data: RefreshSubscriptionResponse): RefreshSubscriptionToast {
  const refreshableSourceCount = normalizeCount(data.refreshableSourceCount);
  const failedSourceCount = normalizeCount(data.failedSourceCount);
  const refreshedSourceCount =
    typeof data.refreshedSourceCount === "number"
      ? normalizeCount(data.refreshedSourceCount)
      : Math.max(0, refreshableSourceCount - failedSourceCount);
  const nodeCount = normalizeCount(data.nodeCount);
  const healthStats = data.healthStats;
  const healthLine =
    healthStats && normalizeCount(healthStats.tested) > 0
      ? `测活：共测试 ${normalizeCount(healthStats.tested)} 个节点，通过 ${normalizeCount(healthStats.ok)} 个`
      : undefined;

  if (data.attemptedUrlFetch === false || refreshableSourceCount === 0) {
    return {
      title: "刷新完成：当前订阅没有可拉取的 URL 源，本次仅重新解析已保存内容。",
      ...(healthLine ? { description: healthLine } : {}),
      variant: "success",
    };
  }

  if (failedSourceCount > 0) {
    return {
      title: `刷新完成：${refreshedSourceCount} 个源已更新，${failedSourceCount} 个源失败`,
      description: ["失败源已保留原可用节点。", healthLine].filter(Boolean).join(" "),
      variant: "warning",
    };
  }

  return {
    title: `刷新完成：${refreshedSourceCount} 个源已更新，共 ${nodeCount} 个节点`,
    ...(healthLine ? { description: healthLine } : {}),
    variant: "success",
  };
}
