"use client";

import { SourcesSection } from "./quick-mode/sources-section";
import { TemplatesSection } from "./quick-mode/templates-section";
import { useCfPreferredPoolSync } from "./use-cf-preferred-pool";

export function QuickMode() {
  useCfPreferredPoolSync();
  return (
    <div className="flex flex-col gap-3">
      <SourcesSection />
      <TemplatesSection />
    </div>
  );
}
