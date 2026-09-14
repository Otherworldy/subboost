/**
 * 从当前浏览器测入口 TCP/TLS：https://IP 在证书失败前仍会完成握手。
 * 超时 = 不通；快速失败（证书名不匹配等）= 可达，用耗时当粗 RTT。
 * 不是 VLESS/VMess/Trojan 握手。SNI 是 IP 本身，和 Clash 真用时的域名 SNI 不同。
 */
export const BROWSER_PROBE_TIMEOUT_MS = 2000;
const BROWSER_PROBE_CONCURRENCY = 8;

export type BrowserProbeDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export function browserProbeUrl(address: string): string | null {
  const host = address.trim();
  if (!host) return null;
  if (host.startsWith("[")) return `https://${host}/`;
  if (host.includes(":")) return `https://[${host}]/`;
  return `https://${host}/`;
}

export async function probeAddressFromBrowser(
  address: string,
  deps: BrowserProbeDeps = {},
): Promise<number | null> {
  const url = browserProbeUrl(address);
  if (!url) return null;
  const timeoutMs = deps.timeoutMs ?? BROWSER_PROBE_TIMEOUT_MS;
  const now = deps.now ?? (() => performance.now());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    await fetchImpl(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return Math.max(0, Math.round(now() - started));
  } catch {
    const ms = Math.max(0, Math.round(now() - started));
    return ms >= timeoutMs - 20 ? null : ms;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAddressesFromBrowser(
  addresses: readonly string[],
  deps: BrowserProbeDeps = {},
): Promise<Map<string, number | null>> {
  const results = new Map<string, number | null>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(BROWSER_PROBE_CONCURRENCY, addresses.length) }, async () => {
    while (cursor < addresses.length) {
      const index = cursor;
      cursor += 1;
      const address = addresses[index];
      results.set(address, await probeAddressFromBrowser(address, deps));
    }
  });
  await Promise.all(workers);
  return results;
}
