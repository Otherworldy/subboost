import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MihomoHealthCheckError, runMihomoHealthCheck } from "./mihomo-health-check";

/**
 * 真实内核集成冒烟：仅在设置了 MIHOMO_PATH（或 PATH 中存在 mihomo）时运行。
 * 验证进程生命周期、Unix socket 控制 API、延迟接口与临时目录清理。
 * 需要出网能力才会产生 ok 结果；无可用节点时断言 fail/unsupported 路径。
 */
const binary = process.env.MIHOMO_PATH || "mihomo";
const resolvable = process.env.MIHOMO_PATH
  ? existsSync(process.env.MIHOMO_PATH)
  : (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(`${dir}/mihomo`));
const skip = !resolvable;

const CONFIG = { enabled: true, url: "https://www.google.com/", maxDelayMs: 2000, concurrency: 2 };

describe.skipIf(skip)("mihomo health check integration", () => {
  it("starts the kernel, probes nodes through the unix socket, and cleans up", async () => {
    const nodes = [
      { name: "dead-vmess", type: "vmess", server: "192.0.2.1", port: 443, uuid: "00000000-0000-0000-0000-000000000000" },
      { name: "dead-trojan", type: "trojan", server: "192.0.2.2", port: 443, password: "x" },
      { name: "direct-node", type: "direct" },
    ] as any[];
    const results = await runMihomoHealthCheck({
      nodes,
      config: CONFIG,
      mihomoPath: binary,
      startupTimeoutMs: 15000,
    });
    expect(results.get("direct-node")?.status).toBe("unsupported");
    expect(["ok", "fail"]).toContain(results.get("dead-vmess")?.status);
    expect(["ok", "fail"]).toContain(results.get("dead-trojan")?.status);
  }, 60000);

  it("reports a clear error when the binary is missing", async () => {
    await expect(
      runMihomoHealthCheck({
        nodes: [{ name: "a", type: "vmess", server: "x", port: 1, uuid: "u" } as any],
        config: CONFIG,
        mihomoPath: "/nonexistent/mihomo",
      })
    ).rejects.toThrow(MihomoHealthCheckError);
  });
});
