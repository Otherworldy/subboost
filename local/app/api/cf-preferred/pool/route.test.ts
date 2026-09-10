import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAdmin: vi.fn(),
  readCfPreferredPool: vi.fn(),
  saveCfPreferredPool: vi.fn(),
  probeCfPreferredPool: vi.fn(),
  resolveCfPreferredPoolAddress: vi.fn(),
  prisma: { subscription: { count: vi.fn() } },
}));

vi.mock("@local/lib/auth", () => ({
  getCurrentAdmin: mocks.getCurrentAdmin,
}));
vi.mock("@local/lib/cf-preferred-pool", () => ({
  readCfPreferredPool: mocks.readCfPreferredPool,
  saveCfPreferredPool: mocks.saveCfPreferredPool,
  probeCfPreferredPool: mocks.probeCfPreferredPool,
  resolveCfPreferredPoolAddress: mocks.resolveCfPreferredPoolAddress,
}));
vi.mock("@local/lib/prisma", () => ({ prisma: mocks.prisma }));

import { GET, POST, PUT } from "./route";

async function readJson(response: Response) {
  return { status: response.status, body: await response.json() };
}

function jsonRequest(method: string, body: unknown) {
  return new Request("https://local.test/api/cf-preferred/pool", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cf preferred pool route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentAdmin.mockResolvedValue({ id: "admin-1", username: "admin" });
  });

  it("requires auth", async () => {
    mocks.getCurrentAdmin.mockResolvedValue(null);
    await expect(readJson(await GET())).resolves.toMatchObject({ status: 401 });
  });

  it("GET returns pool and subscription count", async () => {
    mocks.readCfPreferredPool.mockResolvedValueOnce({ enabled: false, entries: [] });
    mocks.prisma.subscription.count.mockResolvedValueOnce(3);
    await expect(readJson(await GET())).resolves.toEqual({
      status: 200,
      body: { pool: { enabled: false, entries: [] }, subscriptionCount: 3 },
    });
  });

  it("PUT saves pool; POST probe/resolve", async () => {
    mocks.saveCfPreferredPool.mockResolvedValueOnce({ enabled: true, entries: [] });
    await expect(readJson(await PUT(jsonRequest("PUT", { enabled: true })))).resolves.toEqual({
      status: 200,
      body: { pool: { enabled: true, entries: [] } },
    });

    mocks.probeCfPreferredPool.mockResolvedValueOnce({ enabled: true, entries: [] });
    await expect(readJson(await POST(jsonRequest("POST", { action: "probe" })))).resolves.toMatchObject({
      status: 200,
      body: { pool: { enabled: true, entries: [] } },
    });

    mocks.resolveCfPreferredPoolAddress.mockResolvedValueOnce([{ ip: "1.1.1.1", ms: 20 }]);
    await expect(
      readJson(await POST(jsonRequest("POST", { action: "resolve", address: "cf.example.com" }))),
    ).resolves.toEqual({
      status: 200,
      body: { candidates: [{ ip: "1.1.1.1", ms: 20 }] },
    });

    await expect(readJson(await POST(jsonRequest("POST", { action: "nope" })))).resolves.toMatchObject({
      status: 400,
    });
  });
});
