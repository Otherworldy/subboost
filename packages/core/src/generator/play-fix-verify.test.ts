import { it, expect } from "vitest";
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

it("dns config pins Google download/video CDNs to international DoH", () => {
  const config = generateClashConfig({ nodes: NODES, template: "standard" } as any);
  const dns = config.dns as Record<string, unknown>;
  const policy = dns["nameserver-policy"] as Record<string, string[]>;
  expect(policy).toBeTruthy();
  expect(policy["+.gvt1.com"]).toBeTruthy();
  expect(policy["+.googlevideo.com"]).toBeTruthy();
  expect(policy["+.googleapis.com"]).toBeTruthy();
});
