import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAdmin: vi.fn(),
  runNodeHealthChecks: vi.fn(),
}));

vi.mock("@local/lib/api-auth", () => ({
  withCurrentAdmin: async (handler: () => unknown) => {
    const admin = await mocks.getCurrentAdmin();
    if (!admin) {
      return new Response(JSON.stringify({ error: "Authentication required.", code: "UNAUTHORIZED" }), {
        status: 401,
      });
    }
    return handler();
  },
}));

vi.mock("@local/lib/node-health-service", () => ({
  runNodeHealthChecks: mocks.runNodeHealthChecks,
}));

import { POST } from "./route";

async function readJson(response: Response) {
  return { status: response.status, body: await response.json() };
}

async function readNdjson(response: Response) {
  const text = await response.text();
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: response.status, lines };
}

function request(body: unknown) {
  return new Request("https://local.test/api/node-health", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("local node health route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentAdmin.mockResolvedValue({ id: "admin-1", username: "admin" });
    mocks.runNodeHealthChecks.mockImplementation(async ({ onNodeResult } = {}) => {
      onNodeResult?.("A", "s1", { status: "ok", delayMs: 10, checkedAt: "t" });
      return {
        nodes: [{ name: "A", health: { s1: { status: "ok", delayMs: 10, checkedAt: "t" } } }],
        summary: { tested: 1, ok: 1, fail: 0, unsupported: 0 },
      };
    });
  });

  it("requires the local administrator", async () => {
    mocks.getCurrentAdmin.mockResolvedValue(null);
    await expect(readJson(await POST(request({ scope: { kind: "all" } })))).resolves.toEqual({
      status: 401,
      body: { error: "Authentication required.", code: "UNAUTHORIZED" },
    });
  });

  it("rejects invalid bodies and scopes", async () => {
    await expect(readJson(await POST(request("{")))).resolves.toMatchObject({ status: 400 });
    await expect(readJson(await POST(request([])))).resolves.toMatchObject({ status: 400 });
    await expect(readJson(await POST(request({ scope: { kind: "wat" } })))).resolves.toMatchObject({ status: 400 });
    await expect(readJson(await POST(request({ scope: { kind: "source" } })))).resolves.toMatchObject({ status: 400 });
    expect(mocks.runNodeHealthChecks).not.toHaveBeenCalled();
  });

  it("forwards all scopes and streams per-node results", async () => {
    const scopes = [
      { kind: "all" },
      { kind: "source", sourceId: " s1 " },
      { kind: "node", nodeName: " A " },
    ];
    for (const scope of scopes) {
      await readNdjson(await POST(request({ scope, nodes: [], sources: [] })));
    }

    expect(mocks.runNodeHealthChecks).toHaveBeenCalledTimes(3);
    expect(mocks.runNodeHealthChecks.mock.calls[1][0].scope).toEqual({ kind: "source", sourceId: "s1" });
    expect(mocks.runNodeHealthChecks.mock.calls[2][0].scope).toEqual({ kind: "node", nodeName: "A" });

    const ok = await readNdjson(await POST(request({ scope: { kind: "all" }, nodes: [], sources: [] })));
    expect(ok.status).toBe(200);
    expect(ok.lines).toEqual([
      {
        type: "result",
        name: "A",
        sourceId: "s1",
        result: { status: "ok", delayMs: 10, checkedAt: "t" },
      },
      { type: "done", summary: { tested: 1, ok: 1, fail: 0, unsupported: 0 } },
    ]);
  });

  it("reports service failures as an error stream line", async () => {
    mocks.runNodeHealthChecks.mockRejectedValueOnce(new Error("未知的导入源"));
    const response = await readNdjson(await POST(request({ scope: { kind: "source", sourceId: "x" } })));
    expect(response.status).toBe(200);
    expect(response.lines).toEqual([{ type: "error", message: "未知的导入源" }]);
  });
});
