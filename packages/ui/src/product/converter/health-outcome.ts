import { toast } from "@subboost/ui/components/ui/toaster";
import type { HealthCheckScope, HealthRunOutcome } from "@subboost/ui/store/config-store/definitions";

/** 手动测活（源级/节点级/整体）完成后统一展示结果摘要，标题标注测试范围避免混淆。 */
export function showHealthRunOutcomeToast(outcome: HealthRunOutcome, scope?: HealthCheckScope): void {
  if (!outcome.ok) {
    if (outcome.error) {
      toast({ title: "测活失败", description: outcome.error, variant: "destructive" });
    }
    return;
  }

  const { tested, ok, fail, unsupported } = outcome.summary;
  const description = [fail > 0 ? `${fail} 个失败` : "", unsupported > 0 ? `${unsupported} 个不支持` : ""]
    .filter(Boolean)
    .join("，");

  const title =
    scope?.kind === "node"
      ? `节点“${scope.nodeName}”测速完成：${ok}/${tested} 个节点通过`
      : scope?.kind === "source"
        ? `源测速完成：${ok}/${tested} 个节点通过`
        : `全部测速完成：${ok}/${tested} 个节点通过`;

  toast({
    title,
    ...(description ? { description } : {}),
    variant: fail > 0 ? "warning" : "success",
  });
}
