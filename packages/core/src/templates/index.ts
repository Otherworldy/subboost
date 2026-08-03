/**
 * 预设模板配置
 */

import type { TemplateConfig, TemplateType } from "@subboost/core/types/config";
import { PROXY_GROUP_MODULES, getModulesForTemplate } from "../generator/proxy-groups";

/**
 * 精简版模板
 * 适合轻度用户，基础代理组 + 国内外分流
 */
const MINIMAL_TEMPLATE: TemplateConfig = {
  id: "minimal",
  name: "精简版",
  description: "基础代理组 + 国内外分流，适合轻度用户",
  groups: getModulesForTemplate("minimal"),
  rules: getModulesForTemplate("minimal"),  // 使用同样的模块列表
  dns: {},
};

/**
 * 标准版模板
 * 完整代理组 + 常用规则，满足大部分需求
 */
const STANDARD_TEMPLATE: TemplateConfig = {
  id: "standard",
  name: "标准版",
  description: "完整代理组 + 常用规则，满足大部分需求",
  groups: getModulesForTemplate("standard"),
  rules: getModulesForTemplate("standard"),
  dns: {},
};

/**
 * 完整版模板
 * 全部功能 + 扩展规则集，适合高级用户
 */
const FULL_TEMPLATE: TemplateConfig = {
  id: "full",
  name: "完整版",
  description: "全部功能 + 扩展规则集，适合高级用户",
  groups: getModulesForTemplate("full"),
  rules: getModulesForTemplate("full"),
  dns: {},
};

/**
 * AI 分流模板
 * 国内外分流 + AI 独立分组（Grok / Gemini / GPT / Claude），适合 AI 重度用户
 */
const AI_TEMPLATE: TemplateConfig = {
  id: "ai",
  name: "AI 分流版",
  description: "国内外分流 + Grok/Gemini/GPT/Claude 独立分组，适合 AI 重度用户",
  groups: getModulesForTemplate("ai"),
  rules: getModulesForTemplate("ai"),
  dns: {},
};

/**
 * 所有预设模板
 */
export const TEMPLATES: Record<TemplateType, TemplateConfig> = {
  minimal: MINIMAL_TEMPLATE,
  standard: STANDARD_TEMPLATE,
  full: FULL_TEMPLATE,
  ai: AI_TEMPLATE,
};

/**
 * 获取模板列表
 */
export function getTemplateList(): Array<{
  id: TemplateType;
  name: string;
  description: string;
  groupCount: number;
  ruleCount: number;
}> {
  return Object.values(TEMPLATES).map((t) => {
    // 计算规则数量
    const ruleCount = t.groups.reduce((acc, groupId) => {
      const proxyMod = PROXY_GROUP_MODULES.find((m) => m.id === groupId);
      return acc + (proxyMod?.rules.length || 0);
    }, 0);
    
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      groupCount: t.groups.length,
      ruleCount: ruleCount,
    };
  });
}

/**
 * 获取指定模板
 */
export function getTemplate(id: TemplateType): TemplateConfig {
  return TEMPLATES[id] || TEMPLATES.standard;
}

/**
 * 验证模板配置
 */
export function validateTemplateConfig(config: Partial<TemplateConfig>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.name || config.name.trim() === "") {
    errors.push("模板名称不能为空");
  }

  if (!config.groups || config.groups.length === 0) {
    errors.push("至少需要选择一个代理组");
  }

  // 验证必须包含的代理组
  const requiredGroups = ["select", "final"];
  for (const group of requiredGroups) {
    if (!config.groups?.includes(group)) {
      errors.push(`必须包含 "${group}" 代理组`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
