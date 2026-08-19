import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { once } from "node:events";
import http from "node:http";
import {
  isMihomoSupportedProxyNode,
  sanitizeMihomoProxyNode,
} from "@subboost/core/mihomo/proxy-sanitizer";
import type { NodeHealthResult } from "@subboost/core/subscription/node-health";
import type { ResolvedSourceHealthCheck } from "@subboost/core/subscription/node-health";
import type { ParsedNode } from "@subboost/core/types/node";

/**
 * 最小 mihomo 测活运行器。
 *
 * 每次调用：写一份最小 JSON 配置（仅 proxies + Unix socket 控制 API），
 * 启动一次性 mihomo 子进程，通过 /proxies/{name}/delay 批量测延迟，
 * 结束后终止进程并删除临时目录。同一服务进程内的调用经模块级队列串行，
 * 避免同时存在多个内核进程；单个调用内部按配置并发。
 */

export class MihomoHealthCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MihomoHealthCheckError";
  }
}

const INTERNAL_UNSUPPORTED_TYPES = new Set(["direct", "dns", "relay"]);
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_GRACE_MS = 2_000;
// 单次测活整体上限：并发 20、每节点最坏 ~4s（2s 延迟上限 + 2s 宽限 + 重试），
// 数千节点全超时也只需 1-2 分钟，3 分钟足够；过长会让 cron 长时间占队、
// 并导致 interactive 排队超时（60s）拿不到结果。
const OVERALL_TIMEOUT_MS = 3 * 60_000;
const STOP_GRACE_MS = 3_000;
// 失败节点重试前的退避：批量测速时大量并发建连容易触发节点服务器限流/排队，
// 退避后重试一次可吸收这类瞬时失败（单节点测速不受影响）。
const RETRY_DELAY_MS = 500;

export type MihomoRequestResult = { status: number; body: string };

class MihomoHealthCheckDeadlineError extends MihomoHealthCheckError {}
class MihomoRequestTimeoutError extends Error {}

export type MihomoHealthCheckDeps = {
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  requestImpl?: (
    socketPath: string,
    method: string,
    path: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<MihomoRequestResult>;
  statImpl?: (path: string) => Promise<unknown>;
  delayImpl?: (ms: number) => Promise<void>;
  mkdtempImpl?: (prefix: string) => Promise<string>;
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  rmImpl?: (path: string) => Promise<void>;
  resolveBinary?: () => string;
};

export type MihomoHealthCheckParams = {
  nodes: ParsedNode[];
  config: ResolvedSourceHealthCheck;
  mihomoPath?: string;
  startupTimeoutMs?: number;
  requestGraceMs?: number;
  overallTimeoutMs?: number;
  stopGraceMs?: number;
  // 每个节点出结果时立即回调（用于流式回显），不传则保持一次性返回
  onResult?: (nodeName: string, result: NodeHealthResult) => void;
};

export function resolveMihomoBinaryPath(override?: string): string {
  const raw = override ?? process.env.MIHOMO_PATH;
  const trimmed = typeof raw === "string" && raw.trim() ? raw.trim() : "";
  if (trimmed) return trimmed;

  // fs.stat 不会按 PATH 解析，这里显式查找可执行文件的实际路径
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "mihomo");
    if (existsSync(candidate)) return candidate;
  }
  return "mihomo";
}

function isProbeableNode(node: ParsedNode): boolean {
  if (INTERNAL_UNSUPPORTED_TYPES.has(node.type)) return false;
  if (!isMihomoSupportedProxyNode(node)) return false;
  // sanitize 可能把个别边缘节点标记为 invalid（例如 xhttp+reality 组合）
  return isMihomoSupportedProxyNode(sanitizeMihomoProxyNode(node) as ParsedNode);
}

export function classifyNodeForHealthCheck(node: ParsedNode): "probe" | "unsupported" {
  return isProbeableNode(node) ? "probe" : "unsupported";
}

function requestUnixSocket(
  socketPath: string,
  method: string,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<MihomoRequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path, agent: false, signal, headers: { "Content-Length": "0" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("aborted", () => reject(new Error("mihomo response aborted")));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([once(child, "exit"), delay(timeoutMs)]);
}

async function stopProcess(child: ChildProcess, graceMs = STOP_GRACE_MS): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await waitForProcessExit(child, graceMs);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForProcessExit(child, graceMs);
  }
}

function captureOutputTail(child: ChildProcess, maxLines = 8): () => string {
  const lines: string[] = [];
  const collect = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
    while (lines.length > maxLines) lines.shift();
  };
  // mihomo 把致命配置错误打到 stdout（level=fatal），stderr 通常为空，两者都捕获
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return () => lines.join(" | ");
}

async function readUrlResult(body: string): Promise<{ delay?: number; message?: string }> {
  try {
    const parsed = JSON.parse(body) as { delay?: unknown; message?: unknown };
    return {
      ...(typeof parsed.delay === "number" && Number.isFinite(parsed.delay) ? { delay: parsed.delay } : {}),
      ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
    };
  } catch {
    return {};
  }
}

type ProbeGroupEntry = { node: ParsedNode; probeName: string };

type ProbeContext = {
  binary: string;
  socketPath: string;
  configPath: string;
  config: ResolvedSourceHealthCheck;
  checkedAt: string;
  startupTimeoutMs: number;
  requestGraceMs: number;
  deadline: number;
  signal: AbortSignal;
  stopGraceMs: number;
  results: Map<string, NodeHealthResult>;
  onResult?: (nodeName: string, result: NodeHealthResult) => void;
};

function recordResult(context: ProbeContext, nodeName: string, result: NodeHealthResult): void {
  context.results.set(nodeName, result);
  context.onResult?.(nodeName, result);
}

type ProbeDeps = Required<
  Pick<MihomoHealthCheckDeps, "spawnImpl" | "requestImpl" | "delayImpl" | "writeFileImpl">
>;

function remainingMs(context: ProbeContext): number {
  return Math.max(0, context.deadline - Date.now());
}

async function requestWithinDeadline(
  context: ProbeContext,
  deps: ProbeDeps,
  method: string,
  path: string,
  timeoutMs: number
): Promise<MihomoRequestResult> {
  const remaining = remainingMs(context);
  if (remaining <= 0) throw new MihomoHealthCheckDeadlineError("测活整体超时");

  const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, remaining));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = Promise.resolve().then(() =>
    deps.requestImpl(context.socketPath, method, path, effectiveTimeoutMs, context.signal)
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (context.signal.aborted || remainingMs(context) <= 0) {
        reject(new MihomoHealthCheckDeadlineError("测活整体超时"));
      } else {
        reject(new MihomoRequestTimeoutError(`mihomo 请求超时（${effectiveTimeoutMs}ms）`));
      }
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 启动一次 mihomo 实例并测活一组节点；启动失败抛 MihomoHealthCheckError（带内核日志尾部）
async function probeGroup(group: ProbeGroupEntry[], context: ProbeContext, deps: ProbeDeps): Promise<void> {
  const { config, checkedAt, results } = context;
  if (remainingMs(context) <= 0) {
    for (const entry of group) recordResult(context, entry.node.name, { status: "fail", checkedAt });
    return;
  }
  let child: ChildProcess | null = null;
  try {
    const proxies = group.map(({ node, probeName }) => {
      const sanitized = sanitizeMihomoProxyNode(node) as Record<string, unknown>;
      // vmess 缺省字段：mihomo 配置加载要求 cipher/alterId 存在（与 Clash 客户端默认一致）
      if (sanitized.type === "vmess") {
        if (typeof sanitized.cipher !== "string" || !sanitized.cipher) sanitized.cipher = "auto";
        if (typeof sanitized.alterId !== "number") sanitized.alterId = 0;
      }
      return { ...sanitized, name: probeName };
    });
    await deps.writeFileImpl(
      context.configPath,
      JSON.stringify(
        {
          "log-level": "silent",
          "external-controller-unix": context.socketPath,
          mode: "rule",
          proxies,
        },
        null,
        2
      )
    );

    child = deps.spawnImpl(context.binary, ["-d", dirname(context.configPath), "-f", context.configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TZ: "UTC" },
    });
    const outputTail = captureOutputTail(child);

    // 等待控制 API 就绪；进程提前退出视为内核启动失败
    const readyDeadline = Math.min(Date.now() + context.startupTimeoutMs, context.deadline);
    let ready = false;
    while (Date.now() < readyDeadline) {
      if (child.exitCode !== null) {
        throw new MihomoHealthCheckError(`mihomo 内核启动失败（退出码 ${child.exitCode}）：${outputTail()}`);
      }
      try {
        const version = await requestWithinDeadline(
          context,
          deps,
          "GET",
          "/version",
          Math.min(1000, Math.max(1, readyDeadline - Date.now()))
        );
        if (version.status === 200) {
          if (child.exitCode !== null) {
            throw new MihomoHealthCheckError(`mihomo 内核启动失败（退出码 ${child.exitCode}）：${outputTail()}`);
          }
          ready = true;
          break;
        }
      } catch {
        // socket 尚未就绪，继续轮询
      }
      const waitMs = Math.min(200, Math.max(0, readyDeadline - Date.now()));
      if (waitMs > 0) await deps.delayImpl(waitMs);
    }
    if (!ready) {
      if (remainingMs(context) <= 0) throw new MihomoHealthCheckDeadlineError("测活整体超时");
      throw new MihomoHealthCheckError(`mihomo 内核在 ${context.startupTimeoutMs}ms 内未就绪：${outputTail()}`);
    }

    const timeoutMs = config.maxDelayMs + context.requestGraceMs;
    // 单节点探测：404=内核不支持（确定性，不重试）；其余失败可重试
    const probeDelay = async (probeName: string): Promise<NodeHealthResult> => {
      const delayPath = `/proxies/${encodeURIComponent(probeName)}/delay?url=${encodeURIComponent(config.url)}&timeout=${config.maxDelayMs}`;
      try {
        const res = await requestWithinDeadline(context, deps, "GET", delayPath, timeoutMs);
        if (res.status === 404) {
          // 内核未加载该代理类型：按不支持处理，不中断同组其他节点
          return { status: "unsupported", checkedAt };
        }
        if (res.status === 200) {
          const { delay: delayMs } = await readUrlResult(res.body);
          if (typeof delayMs === "number") {
            return { status: "ok", delayMs, checkedAt };
          }
        }
        return { status: "fail", checkedAt };
      } catch (error) {
        if (error instanceof MihomoHealthCheckDeadlineError) return { status: "fail", checkedAt };
        if (error instanceof MihomoHealthCheckError) throw error;
        return { status: "fail", checkedAt };
      }
    };
    let index = 0;
    const workers = Array.from({ length: Math.min(config.concurrency, group.length) }, async () => {
      while (index < group.length) {
        const current = index;
        index += 1;
        const { node, probeName } = group[current];
        if (Date.now() >= context.deadline) {
          recordResult(context, node.name, { status: "fail", checkedAt });
          continue;
        }
        let result = await probeDelay(probeName);
        if (result.status === "fail" && remainingMs(context) > 0) {
          // 瞬时失败（并发限流/连接排队）重试一次；再次失败才判定为不通
          await deps.delayImpl(Math.min(RETRY_DELAY_MS, remainingMs(context)));
          if (remainingMs(context) > 0) result = await probeDelay(probeName);
        }
        recordResult(context, node.name, result);
      }
    });
    await Promise.all(workers);
  } finally {
    if (child) await stopProcess(child, context.stopGraceMs).catch(() => undefined);
  }
}

type RunningDeps = Required<
  Pick<
    MihomoHealthCheckDeps,
    "spawnImpl" | "requestImpl" | "statImpl" | "delayImpl" | "mkdtempImpl" | "writeFileImpl" | "rmImpl"
  >
>;

export async function executeHealthCheck(
  params: MihomoHealthCheckParams,
  deps: RunningDeps
): Promise<Map<string, NodeHealthResult>> {
  const { nodes, config } = params;
  const checkedAt = new Date().toISOString();
  const results = new Map<string, NodeHealthResult>();
  const record = (nodeName: string, result: NodeHealthResult) => {
    results.set(nodeName, result);
    params.onResult?.(nodeName, result);
  };

  const probeable: Array<{ node: ParsedNode; probeName: string }> = [];
  for (const node of nodes) {
    if (classifyNodeForHealthCheck(node) === "probe") {
      probeable.push({ node, probeName: `probe-${probeable.length + 1}` });
    } else {
      record(node.name, { status: "unsupported", checkedAt });
    }
  }

  if (probeable.length === 0) return results;

  const binary = resolveMihomoBinaryPath(params.mihomoPath);
  try {
    await deps.statImpl(binary);
  } catch {
    throw new MihomoHealthCheckError(
      `未找到 mihomo 内核（${binary}）。请设置 MIHOMO_PATH 环境变量指向 mihomo 可执行文件，或使用包含内核的生产镜像。`
    );
  }

  const tempDir = await deps.mkdtempImpl(join(tmpdir(), "subboost-mihomo-"));
  const socketPath = join(tempDir, "mihomo.sock");
  const configPath = join(tempDir, "config.json");
  const startupTimeoutMs = params.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const requestGraceMs = params.requestGraceMs ?? REQUEST_GRACE_MS;
  const overallTimeoutMs = params.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
  const stopGraceMs = params.stopGraceMs ?? STOP_GRACE_MS;
  const deadline = Date.now() + Math.max(0, overallTimeoutMs);
  const abortController = new AbortController();
  const deadlineTimer = setTimeout(() => abortController.abort(), Math.max(0, overallTimeoutMs));
  const context: ProbeContext = {
    binary,
    socketPath,
    configPath,
    config,
    checkedAt,
    startupTimeoutMs,
    requestGraceMs,
    deadline,
    signal: abortController.signal,
    stopGraceMs,
    results,
    onResult: params.onResult,
  };

  try {
    await probeGroup(probeable, context, deps);
  } catch (error) {
    if (!(error instanceof MihomoHealthCheckError)) throw error;
    if (error instanceof MihomoHealthCheckDeadlineError || remainingMs(context) <= 0) {
      for (const entry of probeable) {
        if (!results.has(entry.node.name)) recordResult(context, entry.node.name, { status: "fail", checkedAt });
      }
      return results;
    }
    // 整体启动失败：按类型分组逐个重试，无法启动的类型整组标记 unsupported，
    // 其余类型照常测活；全部类型都无法启动才视为系统性失败（保留旧快照）。
    const groups = new Map<string, ProbeGroupEntry[]>();
    for (const entry of probeable) {
      const list = groups.get(entry.node.type) ?? [];
      list.push(entry);
      groups.set(entry.node.type, list);
    }
    let startedAny = false;
    for (const group of groups.values()) {
      try {
        await probeGroup(group, context, deps);
        startedAny = true;
      } catch (groupError) {
        if (!(groupError instanceof MihomoHealthCheckError)) throw groupError;
        if (groupError instanceof MihomoHealthCheckDeadlineError || remainingMs(context) <= 0) {
          for (const entry of probeable) {
            if (!results.has(entry.node.name)) recordResult(context, entry.node.name, { status: "fail", checkedAt });
          }
          return results;
        }
        for (const entry of group) {
          recordResult(context, entry.node.name, { status: "unsupported", checkedAt });
        }
      }
    }
    if (!startedAny) throw error;
  } finally {
    // 到达整体 deadline 时即使 probeGroup 已收尾也要 abort，避免收尾先于 timer
    // 回调时吞掉超时信号；未超时的调用则及时释放 timer。
    if (remainingMs(context) <= 0) abortController.abort();
    clearTimeout(deadlineTimer);
    await deps.rmImpl(tempDir).catch(() => undefined);
  }

  return results;
}

const defaultDeps: RunningDeps = {
  spawnImpl: spawn,
  requestImpl: requestUnixSocket,
  statImpl: (path) => stat(path),
  delayImpl: delay,
  mkdtempImpl: (prefix) => mkdtemp(prefix),
  writeFileImpl: (path, content) => writeFile(path, content, "utf8"),
  rmImpl: (path) => rm(path, { recursive: true, force: true }),
};

// 进程级串行队列：同一服务进程内同一时刻只跑一个 mihomo 实例。
// 拆两条队列互不阻塞：background 给定时/自动刷新（cron），interactive 给用户在线等待的
// 手动测活、保存订阅与手动刷新；interactive 排队超过上限直接明确失败并取消执行，
// 避免用户被后台批处理无限期阻塞且无任何反馈。
let mihomoQueue: Promise<unknown> = Promise.resolve();
let interactiveQueue: Promise<unknown> = Promise.resolve();

const QUEUE_WAIT_TIMEOUT_MS = 60_000;
const QUEUE_TIMEOUT_MESSAGE = "排队超时：当前有其他测活任务正在进行，请稍后重试";

export type MihomoHealthCheckQueue = "interactive" | "background";

export function runMihomoHealthCheck(
  params: MihomoHealthCheckParams,
  queue: MihomoHealthCheckQueue = "background",
  options: { deps?: RunningDeps; queueWaitMs?: number } = {}
): Promise<Map<string, NodeHealthResult>> {
  const run = () => executeHealthCheck(params, options.deps ?? defaultDeps);
  if (queue === "interactive") {
    // 超时后标记取消：队列释放时不再执行，避免任务白跑且向已关闭的流回写结果。
    // 仅限制排队时间；已经拿到队列槽位的测活可正常运行至整体 deadline。
    const controller = new AbortController();
    let queueTimeout: ReturnType<typeof setTimeout> | undefined;
    const queued = interactiveQueue.then(
      () => {
        if (queueTimeout) clearTimeout(queueTimeout);
        if (controller.signal.aborted) throw new MihomoHealthCheckError(QUEUE_TIMEOUT_MESSAGE);
        return run();
      },
      () => {
        if (queueTimeout) clearTimeout(queueTimeout);
        if (controller.signal.aborted) throw new MihomoHealthCheckError(QUEUE_TIMEOUT_MESSAGE);
        return run();
      }
    );
    interactiveQueue = queued.catch(() => undefined);
    return new Promise((resolve, reject) => {
      queueTimeout = setTimeout(() => {
        controller.abort();
        reject(new MihomoHealthCheckError(QUEUE_TIMEOUT_MESSAGE));
      }, options.queueWaitMs ?? QUEUE_WAIT_TIMEOUT_MS);
      queued.then(resolve, reject);
    });
  }
  const queued = mihomoQueue.then(run, run);
  mihomoQueue = queued.catch(() => undefined);
  return queued;
}
