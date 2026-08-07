import { DEFAULT_DNS_CONFIG } from "@subboost/core/generator/dns";
import { DEFAULT_RULE_PROVIDER_BASE_URL } from "@subboost/core/rules/metadata";
import { TEMPLATES } from "@subboost/core/templates";
import { SUBBOOST_TEMPLATE_CONFIG_SCHEMA } from "@subboost/core/templates/config-template";
import type { ClashConfig, TemplateType, UserConfig } from "@subboost/core/types/config";
import type { SubBoostTemplateConfig } from "@subboost/core/types/template-config";

export const DEFAULT_SUBBOOST_CONFIG = {
  autoSelectStrategy: "url-test",
  testUrl: "https://www.gstatic.com/generate_204",
  testInterval: 300,
  ruleProviderBaseUrl: DEFAULT_RULE_PROVIDER_BASE_URL,
  customRules: [],
  ruleOrder: [],
  cnIpNoResolve: true,
  experimentalCnUseCnRuleSet: true,
  dnsYaml: "",
  mixedPort: 7897,
  allowLan: true,
} as const satisfies Omit<UserConfig, "enabledGroups" | "enabledRules">;

export function buildDefaultUserConfig(template: TemplateType): UserConfig {
  const templateConfig = TEMPLATES[template];
  return {
    enabledGroups: templateConfig.groups,
    enabledRules: templateConfig.rules,
    autoSelectStrategy: DEFAULT_SUBBOOST_CONFIG.autoSelectStrategy,
    testUrl: DEFAULT_SUBBOOST_CONFIG.testUrl,
    testInterval: DEFAULT_SUBBOOST_CONFIG.testInterval,
    ruleProviderBaseUrl: DEFAULT_SUBBOOST_CONFIG.ruleProviderBaseUrl,
    customRules: [...DEFAULT_SUBBOOST_CONFIG.customRules],
    ruleOrder: [...DEFAULT_SUBBOOST_CONFIG.ruleOrder],
    cnIpNoResolve: DEFAULT_SUBBOOST_CONFIG.cnIpNoResolve,
    experimentalCnUseCnRuleSet: DEFAULT_SUBBOOST_CONFIG.experimentalCnUseCnRuleSet,
    dnsYaml: DEFAULT_SUBBOOST_CONFIG.dnsYaml,
    mixedPort: DEFAULT_SUBBOOST_CONFIG.mixedPort,
    allowLan: DEFAULT_SUBBOOST_CONFIG.allowLan,
  };
}

export function buildDefaultBaseConfigPatch(options: {
  mixedPort?: number;
  allowLan?: boolean;
} = {}): ClashConfig {
  return {
    "mixed-port": options.mixedPort ?? DEFAULT_SUBBOOST_CONFIG.mixedPort,
    "allow-lan": options.allowLan ?? DEFAULT_SUBBOOST_CONFIG.allowLan,
    mode: "rule",
    "log-level": "info",
    "unified-delay": true,
    "tcp-concurrent": true,
    "find-process-mode": "strict",
    dns: DEFAULT_DNS_CONFIG,
    profile: {
      "store-selected": true,
      "store-fake-ip": false,
    },
    sniffer: {
      enable: true,
      "parse-pure-ip": true,
      sniff: {
        TLS: { ports: [443, 8443] },
        HTTP: { ports: [80, "8080-8880"], "override-destination": true },
        QUIC: { ports: [443, 8443] },
      },
    },
    "geodata-mode": true,
    "geo-auto-update": true,
    "geodata-loader": "standard",
    "geo-update-interval": 24,
    "geox-url": {
      geoip: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat",
      geosite: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat",
      mmdb: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb",
      asn: "https://github.com/xishang0128/geoip/releases/download/latest/GeoLite2-ASN.mmdb",
    },
  };
}

export function buildDefaultSubBoostTemplateConfig(type: TemplateType): SubBoostTemplateConfig {
  const template = TEMPLATES[type];
  return {
    schema: SUBBOOST_TEMPLATE_CONFIG_SCHEMA,
    template: type,
    enabledProxyGroups: template.groups,
    hiddenProxyGroups: [],
    customProxyGroups: [],
    proxyGroupAdvanced: {},
    proxyGroupAdvancedModeEnabled: false,
    customRuleSets: [],
    builtinRuleEdits: {},
    customRules: [],
    ruleOrder: [],
    cnIpNoResolve: DEFAULT_SUBBOOST_CONFIG.cnIpNoResolve,
    experimentalCnUseCnRuleSet: DEFAULT_SUBBOOST_CONFIG.experimentalCnUseCnRuleSet,
    dialerProxyGroups: [],
    proxyGroupNameOverrides: {},
    dnsYaml: DEFAULT_BASE_CONFIG_YAML,
    mixedPort: DEFAULT_SUBBOOST_CONFIG.mixedPort,
    allowLan: DEFAULT_SUBBOOST_CONFIG.allowLan,
    testUrl: DEFAULT_SUBBOOST_CONFIG.testUrl,
    testInterval: DEFAULT_SUBBOOST_CONFIG.testInterval,
    ruleProviderBaseUrl: DEFAULT_SUBBOOST_CONFIG.ruleProviderBaseUrl,
  };
}

export const DEFAULT_BASE_CONFIG_YAML = `# 基础配置
mixed-port: ${DEFAULT_SUBBOOST_CONFIG.mixedPort}
allow-lan: ${DEFAULT_SUBBOOST_CONFIG.allowLan}
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true
find-process-mode: strict

# DNS 配置
dns:
  enable: true
  listen: "127.0.0.1:5335"
  respect-rules: true
  use-system-hosts: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver: [223.5.5.5, 119.29.29.29]
  nameserver: ["https://dns.alidns.com/dns-query#DIRECT", "https://doh.pub/dns-query#DIRECT"]
  proxy-server-nameserver: ["https://dns.alidns.com/dns-query#DIRECT", "https://doh.pub/dns-query#DIRECT"]
  fallback: ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
  fallback-lazy-query: true
  fallback-filter: {geoip: true, geoip-code: CN, ipcidr: [240.0.0.0/4, 0.0.0.0/32, 127.0.0.1/32], domain: ["+.google.com", "+.facebook.com", "+.twitter.com", "+.youtube.com", "+.xn--ngstr-lra8j.com", "+.google.cn", "+.googleapis.cn", "+.googleapis.com", "+.gvt1.com"]}
  nameserver-policy:
    "+.gvt1.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
    "+.gvt2.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
    "+.gvt3.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
    "+.googlevideo.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
    "+.ggpht.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
    "+.googleusercontent.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
    "+.googleapis.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
    "+.gstatic.com": ["https://1.1.1.1/dns-query#RULES", "https://8.8.8.8/dns-query#RULES"]
  fake-ip-filter: ["*.lan", "stun.*.*.*", "stun.*.*", time.windows.com, time.nist.gov, time.apple.com, time.asia.apple.com, "*.ntp.org.cn", "*.openwrt.pool.ntp.org", time1.cloud.tencent.com, time.ustc.edu.cn, pool.ntp.org, ntp.ubuntu.com, ntp.aliyun.com, ntp1.aliyun.com, ntp2.aliyun.com, ntp3.aliyun.com, ntp4.aliyun.com, ntp5.aliyun.com, ntp6.aliyun.com, ntp7.aliyun.com, time1.aliyun.com, time2.aliyun.com, time3.aliyun.com, time4.aliyun.com, time5.aliyun.com, time6.aliyun.com, time7.aliyun.com, "*.time.edu.cn", time1.apple.com, time2.apple.com, time3.apple.com, time4.apple.com, time5.apple.com, time6.apple.com, time7.apple.com, time1.google.com, time2.google.com, time3.google.com, time4.google.com, music.163.com, "*.music.163.com", "*.126.net", musicapi.taihe.com, music.taihe.com, songsearch.kugou.com, trackercdn.kugou.com, "*.kuwo.cn", api-jooxtt.sanook.com, api.joox.com, joox.com, y.qq.com, "*.y.qq.com", streamoc.music.tc.qq.com, mobileoc.music.tc.qq.com, isure.stream.qqmusic.qq.com, dl.stream.qqmusic.qq.com, aqqmusic.tc.qq.com, amobile.music.tc.qq.com, "*.xiami.com", "*.music.migu.cn", music.migu.cn, "*.msftconnecttest.com", "*.msftncsi.com", localhost.ptlogin2.qq.com, "*.*.*.srv.nintendo.net", "*.*.stun.playstation.net", "xbox.*.*.microsoft.com", "*.ipv6.microsoft.com", "*.*.xboxlive.com", speedtest.cros.wr.pvp.net]

# 配置文件管理
profile:
  store-selected: true
  store-fake-ip: false

# 域名/流量嗅探
sniffer:
  enable: true
  parse-pure-ip: true
  sniff:
    TLS: {ports: [443, 8443]}
    HTTP: {ports: [80, 8080-8880], override-destination: true}
    QUIC: {ports: [443, 8443]}`;
