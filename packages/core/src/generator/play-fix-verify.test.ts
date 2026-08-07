import { it, expect } from "vitest";
import { DEFAULT_BASE_CONFIG_YAML } from "@subboost/core/config/defaults";
import { generateClashConfig } from "@subboost/core/generator";

const NODES = [{ name: "n1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-256-gcm", password: "x" }];

it("standard: google rules precede cn so polluted download IPs are not caught by geoip:cn", () => {
  const config = generateClashConfig({ nodes: NODES, template: "standard" } as any);
  const rules = config.rules as string[];
  const idxCnIp = rules.findIndex((r) => r.startsWith("RULE-SET,cn-ip"));
  const idxGoogle = rules.findIndex((r) => r.startsWith("RULE-SET,google,"));
  const idxGoogleIp = rules.findIndex((r) => r.startsWith("RULE-SET,google-ip"));
  const idxYoutube = rules.findIndex((r) => r.startsWith("RULE-SET,youtube"));
  expect(idxGoogle).toBeGreaterThanOrEqual(0);
  expect(idxGoogleIp).toBeGreaterThanOrEqual(0);
  expect(idxYoutube).toBeGreaterThanOrEqual(0);
  // google 域名/IP 规则必须在 cn-ip 之前
  expect(idxGoogle).toBeLessThan(idxCnIp);
  expect(idxGoogleIp).toBeLessThan(idxCnIp);
  expect(idxYoutube).toBeLessThan(idxCnIp);
});

it("uses direct mainland DNS and routes international DNS by rules in both default paths", () => {
  const configs = [
    generateClashConfig({ nodes: NODES, template: "standard" } as any),
    generateClashConfig({
      nodes: NODES,
      template: "standard",
      userConfig: { dnsYaml: DEFAULT_BASE_CONFIG_YAML },
    } as any),
  ];

  for (const config of configs) {
    const dns = config.dns as Record<string, unknown>;
    const policy = dns["nameserver-policy"] as Record<string, string[]>;
    expect(dns["respect-rules"]).toBe(true);
    expect(dns["fallback-lazy-query"]).toBe(true);
    expect(dns.nameserver).toEqual([
      "https://dns.alidns.com/dns-query#DIRECT",
      "https://doh.pub/dns-query#DIRECT",
    ]);
    expect(dns["proxy-server-nameserver"]).toEqual(dns.nameserver);
    expect(dns.fallback).toEqual([
      "https://1.1.1.1/dns-query#RULES",
      "https://8.8.8.8/dns-query#RULES",
    ]);
    expect(policy["+.gvt1.com"].every((server) => server.endsWith("#RULES"))).toBe(true);
    expect(policy["+.googlevideo.com"].every((server) => server.endsWith("#RULES"))).toBe(true);
    expect(policy["+.googleapis.com"].every((server) => server.endsWith("#RULES"))).toBe(true);
  }
});
