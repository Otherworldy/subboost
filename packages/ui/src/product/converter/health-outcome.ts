import { toast } from "@subboost/ui/components/ui/toaster";
import type { HealthRunOutcome } from "@subboost/ui/store/config-store/definitions";

/** 手动测活（源级/节点级/整体）完成后统一展示结果摘要。 */
export function showHealthRunOutcomeToast(outcome: HealthRunOutcome): void {
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

  toast({
    title: `测活完成：${ok}/${tested} 个节点通过`,
    ...(description ? { description } : {}),
    variant: fail > 0 ? "warning" : "success",
  });
}
