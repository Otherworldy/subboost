import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROBE_TIMEOUT_MS,
  browserProbeUrl,
  probeAddressFromBrowser,
  probeAddressesFromBrowser,
} from "./cf-preferred-browser-probe";

describe("browserProbeUrl", () => {
  it("wraps IPv6 and leaves IPv4 / domain / already-bracketed alone", () => {
    expect(browserProbeUrl("104.16.1.1")).toBe("https://104.16.1.1/");
    expect(browserProbeUrl("cf.example.com")).toBe("https://cf.example.com/");
    expect(browserProbeUrl("2606:4700:4700::1111")).toBe("https://[2606:4700:4700::1111]/");
    expect(browserProbeUrl("[2606:4700::1]")).toBe("https://[2606:4700::1]/");
    expect(browserProbeUrl("  ")).toBeNull();
  });
});

describe("probeAddressFromBrowser", () => {
  it("opaque success records elapsed ms", async () => {
    let t = 0;
    await expect(
      probeAddressFromBrowser("1.1.1.1", {
        fetchImpl: vi.fn(async () => new Response(null)),
        now: () => (t += 25),
      }),
    ).resolves.toBe(25);
  });

  it("fast network error counts as reachable (TCP/TLS then cert fail)", async () => {
    let t = 0;
    await expect(
      probeAddressFromBrowser("1.1.1.1", {
        fetchImpl: vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
        now: () => (t += 40),
      }),
    ).resolves.toBe(40);
  });

  it("timeout / abort near the budget is unreachable", async () => {
    let t = 0;
    await expect(
      probeAddressFromBrowser("203.0.113.1", {
        timeoutMs: 30,
        now: () => (t === 0 ? ((t = 1), 0) : 30),
        fetchImpl: vi.fn(async () => {
          throw new DOMException("Aborted", "AbortError");
        }),
      }),
    ).resolves.toBeNull();
  });
});

describe("probeAddressesFromBrowser", () => {
  it("returns a result per address", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("203.0.113.9")) throw new TypeError("Failed to fetch");
      return new Response(null);
    });
    const results = await probeAddressesFromBrowser(["1.1.1.1", "203.0.113.9"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 10,
      timeoutMs: BROWSER_PROBE_TIMEOUT_MS,
    });
    expect([...results.keys()].sort()).toEqual(["1.1.1.1", "203.0.113.9"]);
    expect(results.get("1.1.1.1")).toBe(0);
    expect(results.get("203.0.113.9")).toBe(0);
  });
});
