import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { NodeHealthResult, ResolvedSourceHealthCheck } from "@subboost/core/subscription/node-health";
import type { ParsedNode } from "@subboost/core/types/node";
import {
  classifyNodeForHealthCheck,
  executeHealthCheck,
  MihomoHealthCheckError,
  resolveMihomoBinaryPath,
  runMihomoHealthCheck,
  type MihomoHealthCheckDeps,
  type MihomoRequestResult,
} from "./mihomo-health-check";

type FakeChild = ChildProcess & {
  emitExit: (code: number) => void;
  emitStderr: (text: string) => void;
  emitStdout: (text: string) => void;
};

function fakeChild(options: { ignoreSigterm?: boolean } = {}): FakeChild {
  const emitter = new EventEmitter();
  const child = emitter as unknown as {
    exitCode: number | null;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    stderr: EventEmitter;
    stdout: EventEmitter;
    emitExit: (code: number) => void;
    emitStderr: (text: string) => void;
    emitStdout: (text: string) => void;
  };
  child.exitCode = null;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") {
      child.emitExit(9);
      return true;
    }
    if (options.ignoreSigterm) return true;
    child.emitExit(0);
    return true;
  }) as (signal?: NodeJS.Signals | number) => boolean;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.emitExit = (code) => {
    child.exitCode = code;
    emitter.emit("exit", code);
  };
  child.emitStderr = (text) => {
    child.stderr.emit("data", Buffer.from(text));
  };
  child.emitStdout = (text) => {
    child.stdout.emit("data", Buffer.from(text));
  };
  return child as unknown as FakeChild;
}

type RequestLog = { method: string; path: string; timeoutMs: number };

function makeRequestHandler(handler: (path: string) => MihomoRequestResult | Promise<MihomoRequestResult>) {
  const log: RequestLog[] = [];
  const requestImpl: NonNullable<MihomoHealthCheckDeps["requestImpl"]> = async (
    _socketPath,
    method,
    path,
    timeoutMs
  ) => {
    log.push({ method, path, timeoutMs });
    return handler(path);
  };
  return { requestImpl, log };
}

const CONFIG: ResolvedSourceHealthCheck = {
  enabled: true,
  url: "https://www.google.com/",
  maxDelayMs: 5000,
  concurrency: 20,
};

function vmess(name: string): ParsedNode {
  return { name, type: "vmess", server: "example.com", port: 443, uuid: "uuid" } as ParsedNode;
}

function makeDeps(overrides: Partial<MihomoHealthCheckDeps> = {}) {
  const child = fakeChild();
  const spawnImpl = vi.fn(() => child);
  const statImpl = vi.fn(async () => undefined);
  const delayImpl = vi.fn(async () => undefined);
  const mkdtempImpl = vi.fn(async () => "/tmp/subboost-mihomo-test");
  const writeFileImpl = vi.fn(async (_path: string, _content: string) => undefined);
  const rmImpl = vi.fn(async () => undefined);
  return {
    child,
    spawnImpl,
    statImpl,
    delayImpl,
    mkdtempImpl,
    writeFileImpl,
    rmImpl,
    deps: {
      spawnImpl,
      statImpl,
      delayImpl,
      mkdtempImpl,
      writeFileImpl,
      rmImpl,
      ...overrides,
    } as Required<
      Pick<
        MihomoHealthCheckDeps,
        "spawnImpl" | "requestImpl" | "statImpl" | "delayImpl" | "mkdtempImpl" | "writeFileImpl" | "rmImpl"
      >
    >,
  };
}

describe("classifyNodeForHealthCheck", () => {
  it("marks internal and unsupported types as unsupported", () => {
    expect(classifyNodeForHealthCheck({ name: "a", type: "direct" } as ParsedNode)).toBe("unsupported");
    expect(classifyNodeForHealthCheck({ name: "a", type: "dns" } as ParsedNode)).toBe("unsupported");
    expect(classifyNodeForHealthCheck({ name: "a", type: "relay" } as ParsedNode)).toBe("unsupported");
    expect(classifyNodeForHealthCheck({ name: "a", type: "socks4", server: "x", port: 1 } as ParsedNode)).toBe(
      "unsupported"
    );
    expect(classifyNodeForHealthCheck({ name: "a", type: "vmess", server: "x", port: 1 } as ParsedNode)).toBe(
      "unsupported"
    );
    expect(
      classifyNodeForHealthCheck({ name: "a", type: "tuic", server: "x", port: 443, password: "p" } as ParsedNode)
    ).toBe("unsupported");
    expect(
      classifyNodeForHealthCheck({
        name: "a",
        type: "tuic",
        server: "x",
        port: 443,
        uuid: "00000000-0000-0000-0000-000000000000",
        password: "p",
      } as ParsedNode)
    ).toBe("probe");
  });

  it("marks supported nodes as probeable", () => {
    expect(classifyNodeForHealthCheck(vmess("ok"))).toBe("probe");
    expect(
      classifyNodeForHealthCheck({ name: "s", type: "ssh", server: "x", port: 22, username: "u", password: "p" } as ParsedNode)
    ).toBe("probe");
  });
});

describe("executeHealthCheck", () => {
  it("returns unsupported results without spawning when nothing is probeable", async () => {
    const { deps, spawnImpl, statImpl } = makeDeps();
    const results = await executeHealthCheck(
      { nodes: [{ name: "d", type: "direct" } as ParsedNode, { name: "r", type: "relay" } as ParsedNode], config: CONFIG },
      deps
    );
    expect([...results.entries()].map(([name, r]) => [name, r.status])).toEqual([
      ["d", "unsupported"],
      ["r", "unsupported"],
    ]);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(statImpl).not.toHaveBeenCalled();
  });

  it("probes nodes with unique temp names and maps delays back", async () => {
    const { requestImpl, log } = makeRequestHandler((path) => {
      if (path.startsWith("/version")) return { status: 200, body: "{}" };
      if (path.includes("probe-1")) return { status: 200, body: JSON.stringify({ delay: 120 }) };
      return { status: 200, body: JSON.stringify({ delay: 80 }) };
    });
    const { deps, child, spawnImpl, mkdtempImpl, writeFileImpl, rmImpl } = makeDeps({ requestImpl });

    const nodes = [vmess("节点 A/1"), vmess("Node B")];
    const results = await executeHealthCheck(
      { nodes, config: { ...CONFIG, maxDelayMs: 3000, concurrency: 2 }, mihomoPath: "/usr/bin/mihomo" },
      deps
    );

    expect([...results.entries()].map(([name, r]) => [name, r.status, r.delayMs])).toEqual([
      ["节点 A/1", "ok", 120],
      ["Node B", "ok", 80],
    ]);
    expect(spawnImpl).toHaveBeenCalledWith(
      "/usr/bin/mihomo",
      ["-d", "/tmp/subboost-mihomo-test", "-f", "/tmp/subboost-mihomo-test/config.json"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] })
    );
    const configJson = JSON.parse(writeFileImpl.mock.calls[0][1] as string);
    expect(configJson["external-controller-unix"]).toBe("/tmp/subboost-mihomo-test/mihomo.sock");
    expect(configJson.proxies.map((p: { name: string }) => p.name)).toEqual(["probe-1", "probe-2"]);
    expect(configJson.proxies[0]).not.toHaveProperty("_sourceIds");

    const delayPaths = log.filter((entry) => entry.path.includes("/delay"));
    expect(delayPaths).toHaveLength(2);
    expect(delayPaths[0].path).toContain(`url=${encodeURIComponent("https://www.google.com/")}&timeout=3000`);
    expect(delayPaths[0].timeoutMs).toBe(3000 + 2000);

    expect(child.exitCode).not.toBeNull();
    expect(rmImpl).toHaveBeenCalledWith("/tmp/subboost-mihomo-test");
    expect(mkdtempImpl).toHaveBeenCalledTimes(1);
  });

  it("respects the per-source concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { requestImpl } = makeRequestHandler(async (path) => {
      if (path.startsWith("/version")) return { status: 200, body: "{}" };
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { status: 200, body: JSON.stringify({ delay: 10 }) };
    });
    const { deps } = makeDeps({ requestImpl });
    const nodes = Array.from({ length: 6 }, (_, i) => vmess(`Node ${i}`));

    await executeHealthCheck({ nodes, config: { ...CONFIG, concurrency: 2 }, mihomoPath: "/usr/bin/mihomo" }, deps);

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("marks timeout and API error responses as failed", async () => {
    const { requestImpl } = makeRequestHandler((path) => {
      if (path.startsWith("/version")) return { status: 200, body: "{}" };
      if (path.includes("probe-1")) return { status: 504, body: "{}" };
      if (path.includes("probe-2")) throw new Error("socket closed");
      if (path.includes("probe-3")) return { status: 200, body: "{}" };
      return { status: 200, body: JSON.stringify({ delay: 5 }) };
    });
    const { deps } = makeDeps({ requestImpl });
    const nodes = [vmess("Timeout"), vmess("Error"), vmess("NoDelay"), vmess("Ok")];

    const results = await executeHealthCheck({ nodes, config: CONFIG, mihomoPath: "/usr/bin/mihomo" }, deps);

    expect([...results.entries()].map(([name, r]) => [name, r.status]).sort()).toEqual(
      [
        ["Timeout", "fail"],
        ["Error", "fail"],
        ["NoDelay", "fail"],
        ["Ok", "ok"],
      ].sort()
    );
  });

  it("retries a failed node once and reports ok on the second attempt", async () => {
    let flakyCalls = 0;
    const { requestImpl } = makeRequestHandler((path) => {
      if (path.startsWith("/version")) return { status: 200, body: "{}" };
      if (path.includes("probe-1")) {
        flakyCalls += 1;
        if (flakyCalls === 1) return { status: 504, body: "{}" };
        return { status: 200, body: JSON.stringify({ delay: 42 }) };
      }
      return { status: 200, body: JSON.stringify({ delay: 5 }) };
    });
    const { deps, delayImpl } = makeDeps({ requestImpl });
    const nodes = [vmess("Flaky"), vmess("Ok")];

    const results = await executeHealthCheck({ nodes, config: CONFIG, mihomoPath: "/usr/bin/mihomo" }, deps);

    expect(results.get("Flaky")).toMatchObject({ status: "ok", delayMs: 42 });
    expect(flakyCalls).toBe(2);
    expect(delayImpl).toHaveBeenCalledWith(500);
  });

  it("does not retry nodes the kernel reports as unsupported", async () => {
    let unsupportedCalls = 0;
    const { requestImpl } = makeRequestHandler((path) => {
      if (path.startsWith("/version")) return { status: 200, body: "{}" };
      if (path.includes("probe-1")) {
        unsupportedCalls += 1;
        return { status: 404, body: "{}" };
      }
      return { status: 200, body: JSON.stringify({ delay: 5 }) };
    });
    const { deps } = makeDeps({ requestImpl });
    const nodes = [vmess("Weird"), vmess("Ok")];

    const results = await executeHealthCheck({ nodes, config: CONFIG, mihomoPath: "/usr/bin/mihomo" }, deps);

    expect(results.get("Weird")).toMatchObject({ status: "unsupported" });
    expect(unsupportedCalls).toBe(1);
  });

  it("throws a helpful error when the binary is missing", async () => {
    const { deps, statImpl } = makeDeps();
    statImpl.mockRejectedValue(new Error("ENOENT"));
    await expect(
      executeHealthCheck({ nodes: [vmess("A")], config: CONFIG, mihomoPath: "/missing/mihomo" }, deps)
    ).rejects.toThrow(MihomoHealthCheckError);
    await expect(
      executeHealthCheck({ nodes: [vmess("A")], config: CONFIG, mihomoPath: "/missing/mihomo" }, deps)
    ).rejects.toThrow("MIHOMO_PATH");
  });

  it("treats early process exit as a systematic startup failure", async () => {
    const child = fakeChild();
    const { deps, spawnImpl } = makeDeps();
    spawnImpl.mockImplementation(() => {
      queueMicrotask(() => {
        child.emitStdout("level=fatal msg=Parse config error: proxy 0: unsupport proxy type: relay");
        child.emitStderr("level=error msg=bad config");
        child.emitExit(1);
      });
      return child;
    });

    await expect(
      executeHealthCheck({ nodes: [vmess("A")], config: CONFIG, mihomoPath: "/usr/bin/mihomo" }, deps)
    ).rejects.toThrow(
      "mihomo 内核启动失败（退出码 1）：level=fatal msg=Parse config error: proxy 0: unsupport proxy type: relay | level=error msg=bad config"
    );
  });

  it("falls back per type when the combined config fails to start", async () => {
    const failing = fakeChild();
    const { requestImpl } = makeRequestHandler((path) =>
      path.startsWith("/version") ? { status: 200, body: "{}" } : { status: 200, body: JSON.stringify({ delay: 40 }) }
    );
    const { deps, spawnImpl, rmImpl } = makeDeps({ requestImpl });
    spawnImpl.mockImplementation(() => {
      if (spawnImpl.mock.calls.length === 1) {
        queueMicrotask(() => failing.emitExit(1));
        return failing;
      }
      return fakeChild();
    });

    const results = await executeHealthCheck(
      { nodes: [vmess("A"), { name: "B", type: "ss", server: "example.com", port: 8388, cipher: "aes-128-gcm", password: "p" } as ParsedNode], config: CONFIG, mihomoPath: "/usr/bin/mihomo" },
      deps
    );

    // 整体启动失败后按类型分组重试：两种类型都成功启动并测活
    expect([...results.entries()].map(([name, r]) => [name, r.status, r.delayMs])).toEqual([
      ["A", "ok", 40],
      ["B", "ok", 40],
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(3);
    expect(rmImpl).toHaveBeenCalledTimes(1);
  });

  it("marks the unstartable type unsupported while probing the rest", async () => {
    const failing = fakeChild();
    const { requestImpl } = makeRequestHandler((path) =>
      path.startsWith("/version") ? { status: 200, body: "{}" } : { status: 200, body: JSON.stringify({ delay: 10 }) }
    );
    const { deps, spawnImpl } = makeDeps({ requestImpl });
    spawnImpl.mockImplementation(() => {
      if (spawnImpl.mock.calls.length === 1 || spawnImpl.mock.calls.length === 2) {
        queueMicrotask(() => failing.emitExit(1));
        return failing;
      }
      return fakeChild();
    });

    const results = await executeHealthCheck(
      {
        nodes: [vmess("A"), vmess("B"), { name: "C", type: "ss", server: "example.com", port: 8388, cipher: "aes-128-gcm", password: "p" } as ParsedNode],
        config: CONFIG,
        mihomoPath: "/usr/bin/mihomo",
      },
      deps
    );

    // 整体失败 → vmess 组再失败（unsupported）→ ss 组成功
    expect([...results.entries()].map(([name, r]) => [name, r.status])).toEqual([
      ["A", "unsupported"],
      ["B", "unsupported"],
      ["C", "ok"],
    ]);
  });

  it("keeps the systematic failure when every type fails to start", async () => {
    const failing = fakeChild();
    const { deps, spawnImpl } = makeDeps();
    spawnImpl.mockImplementation(() => {
      queueMicrotask(() => failing.emitExit(1));
      return failing;
    });

    await expect(
      executeHealthCheck(
        { nodes: [vmess("A"), { name: "B", type: "ss", server: "example.com", port: 8388, cipher: "aes-128-gcm", password: "p" } as ParsedNode], config: CONFIG, mihomoPath: "/usr/bin/mihomo" },
        deps
      )
    ).rejects.toThrow("mihomo 内核启动失败（退出码 1）");
  });

  it("marks probes the kernel did not load as unsupported instead of failing the run", async () => {
    const { requestImpl } = makeRequestHandler((path) =>
      path.startsWith("/version") ? { status: 200, body: "{}" } : { status: 404, body: "{}" }
    );
    const { deps } = makeDeps({ requestImpl });

    const results = await executeHealthCheck({ nodes: [vmess("A")], config: CONFIG, mihomoPath: "/usr/bin/mihomo" }, deps);

    expect([...results.entries()].map(([name, r]) => [name, r.status])).toEqual([["A", "unsupported"]]);
  });

  it("force-kills a process that ignores SIGTERM and still cleans up", async () => {
    const { requestImpl } = makeRequestHandler((path) =>
      path.startsWith("/version") ? { status: 200, body: "{}" } : { status: 200, body: JSON.stringify({ delay: 10 }) }
    );
    const child = fakeChild({ ignoreSigterm: true });
    const { deps, spawnImpl, rmImpl } = makeDeps({ requestImpl });
    spawnImpl.mockReturnValue(child);

    await executeHealthCheck(
      { nodes: [vmess("A")], config: CONFIG, mihomoPath: "/usr/bin/mihomo", stopGraceMs: 50 },
      deps
    );

    expect(child.exitCode).toBe(9);
    expect(rmImpl).toHaveBeenCalledWith("/tmp/subboost-mihomo-test");
  });

  it("fails remaining nodes once the overall deadline passes", async () => {
    const { requestImpl, log } = makeRequestHandler((path) =>
      path.startsWith("/version") ? { status: 200, body: "{}" } : { status: 200, body: JSON.stringify({ delay: 10 }) }
    );
    const { deps } = makeDeps({ requestImpl });

    const results = await executeHealthCheck(
      { nodes: [vmess("A"), vmess("B")], config: CONFIG, mihomoPath: "/usr/bin/mihomo", overallTimeoutMs: 0 },
      deps
    );

    expect([...results.entries()].map(([name, r]) => [name, r.status])).toEqual([
      ["A", "fail"],
      ["B", "fail"],
    ]);
    expect(log.filter((entry) => entry.path.includes("/delay"))).toHaveLength(0);
  });

  it("settles and cleans up when many delay requests never return", async () => {
    let signal: AbortSignal | undefined;
    const requestImpl = vi.fn(
      async (_socketPath: string, _method: string, path: string, _timeoutMs: number, requestSignal?: AbortSignal) => {
        signal = requestSignal;
        if (path.startsWith("/version")) return { status: 200, body: "{}" };
        return new Promise<MihomoRequestResult>(() => undefined);
      }
    );
    const { deps, child, rmImpl } = makeDeps({ requestImpl });
    const nodes = Array.from({ length: 40 }, (_, index) => vmess(`Node ${index}`));

    const results = await executeHealthCheck(
      { nodes, config: { ...CONFIG, concurrency: 2 }, mihomoPath: "/usr/bin/mihomo", overallTimeoutMs: 20 },
      deps
    );

    expect(results).toHaveLength(nodes.length);
    expect([...results.values()].every((result) => result.status === "fail")).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(child.exitCode).not.toBeNull();
    expect(rmImpl).toHaveBeenCalledWith("/tmp/subboost-mihomo-test");
  });
});

describe("resolveMihomoBinaryPath", () => {
  const previous = process.env.MIHOMO_PATH;

  afterEach(() => {
    if (previous === undefined) delete process.env.MIHOMO_PATH;
    else process.env.MIHOMO_PATH = previous;
  });

  it("prefers the explicit override, then the env var, then PATH lookup", () => {
    expect(resolveMihomoBinaryPath("/custom/mihomo")).toBe("/custom/mihomo");
    process.env.MIHOMO_PATH = "/env/mihomo";
    expect(resolveMihomoBinaryPath()).toBe("/env/mihomo");
    delete process.env.MIHOMO_PATH;
    expect(resolveMihomoBinaryPath()).toBe("mihomo");
  });
});

describe("health result shape", () => {
  it("stamps checkedAt on every result", async () => {
    const { requestImpl } = makeRequestHandler((path) =>
      path.startsWith("/version") ? { status: 200, body: "{}" } : { status: 200, body: JSON.stringify({ delay: 10 }) }
    );
    const { deps } = makeDeps({ requestImpl });
    const results = await executeHealthCheck(
      { nodes: [vmess("A"), { name: "U", type: "relay" } as ParsedNode], config: CONFIG, mihomoPath: "/usr/bin/mihomo" },
      deps
    );
    for (const result of results.values()) {
      expect(typeof (result as NodeHealthResult).checkedAt).toBe("string");
    }
  });
});

describe("runMihomoHealthCheck 队列", () => {
  it("interactive 排队超时明确失败，且队列释放后不再执行", async () => {
    const hold = makeDeps({ requestImpl: async (_s, _m, path) => ({ status: path.startsWith("/version") ? 200 : 404, body: "" }) });
    let release: () => void = () => undefined;
    hold.statImpl.mockReturnValueOnce(new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    }));
    const first = runMihomoHealthCheck({ nodes: [vmess("A")], config: CONFIG }, "interactive", {
      deps: hold.deps,
    });
    const second = runMihomoHealthCheck({ nodes: [vmess("B")], config: CONFIG }, "interactive", {
      queueWaitMs: 30,
    });
    try {
      await expect(second).rejects.toThrow("排队超时：当前有其他测活任务正在进行，请稍后重试");
      expect(hold.spawnImpl).not.toHaveBeenCalled();
      release();
      const results = await first;
      expect(results.get("A")?.status).toBe("unsupported");
      // 队列释放后，超时任务不再补跑
      expect(hold.spawnImpl).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first.catch(() => undefined);
    }
  });

  it("interactive 队列不被 background 任务阻塞", async () => {
    const hold = makeDeps();
    hold.statImpl.mockReturnValueOnce(new Promise<undefined>(() => undefined));
    const background = runMihomoHealthCheck({ nodes: [vmess("A")], config: CONFIG }, "background", {
      deps: hold.deps,
    });
    // 空节点立即完成：不用等 background 释放队列
    await expect(
      runMihomoHealthCheck({ nodes: [], config: CONFIG }, "interactive", { queueWaitMs: 30 })
    ).resolves.toEqual(new Map());
    background.catch(() => undefined);
  });
});
