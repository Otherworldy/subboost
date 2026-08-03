import { describe, it, expect } from "vitest";
import { generateClashConfig } from "@subboost/core/generator";
import { TEMPLATES } from "@subboost/core/templates";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";

describe("ai template", () => {
  it("is included in preset templates with AI groups", () => {
    expect(TEMPLATES.ai.name).toBe("AI 分流版");
    expect(TEMPLATES.ai.groups).toContain("grok");
    expect(TEMPLATES.ai.groups).toContain("gemini");
    expect(TEMPLATES.ai.groups).toContain("gpt");
    expect(TEMPLATES.ai.groups).toContain("claude");
    expect(TEMPLATES.ai.groups).toContain("cn");
    expect(TEMPLATES.ai.groups).toContain("global");
  });

  it("generates proxy groups and rules in the right order", () => {
    const config = generateClashConfig({ nodes: [], template: "ai" } as any);
    const groups = (config["proxy-groups"] as Array<{ name: string }>).map((g) => g.name);
    const groupText = JSON.stringify(groups);
    const aiGroupIndex = Math.max(groups.findIndex((n) => n.includes("AI")), 0);
    expect(groupText).toContain("Grok");
    expect(groupText).toContain("Gemini");
    expect(groupText).toContain("GPT");
    expect(groupText).toContain("Claude");

    const rules = (config.rules as string[]).join("\n");
    const idxGrok = rules.indexOf("RULE-SET,xai,");
    const idxGemini = rules.indexOf("RULE-SET,google-gemini,");
    const idxGpt = rules.indexOf("RULE-SET,chatgpt,");
    const idxClaude = rules.indexOf("RULE-SET,claude,");
    const idxAi = rules.indexOf("RULE-SET,category-ai-chat-!cn,");
    const idxGoogle = rules.indexOf("RULE-SET,google,");
    // Gemini/Grok/GPT/Claude 必须排在 ai 兜底和 google 之前
    for (const [a, b] of [[idxGemini, idxAi], [idxGrok, idxAi], [idxGpt, idxAi], [idxClaude, idxAi], [idxAi, idxGoogle]] as const) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(b);
    }
    // rule-providers 引用正确的 geosite 规则集
    const providers = (config["rule-providers"] as Record<string, { url: string }>);
    expect(providers.xai.url).toContain("geosite/xai.mrs");
    expect(providers.chatgpt.url).toContain("geosite/openai.mrs");
    expect(providers.claude.url).toContain("geosite/anthropic.mrs");
    expect(providers["google-gemini"].url).toContain("geosite/google-gemini.mrs");
  });

  it("keeps rule ids unique across all preset modules", () => {
    const ids = PROXY_GROUP_MODULES.flatMap((m) => m.rules.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
