import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAdmin: vi.fn(),
  previewCfPreferredByNodes: vi.fn(),
}));

vi.mock("@local/lib/api-auth", () => ({
  withCurrentAdmin: async (handler: (admin: { id: string }) => unknown) => {
    const admin = await mocks.getCurrentAdmin();
    if (!admin) {
      return new Response(JSON.stringify({ error: "Authentication required.", code: "UNAUTHORIZED" }), {
        status: 401,
      });
    }
    return handler(admin);
  },
}));

vi.mock("@local/lib/cf-preferred-preview", () => ({
  previewCfPreferredByNodes: mocks.previewCfPreferredByNodes,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new Request("https://local.test/api/cf-preferred/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readJson(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("cf-preferred preview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentAdmin.mockResolvedValue({ id: "admin-1" });
    mocks.previewCfPreferredByNodes.mockResolvedValue({
      candidates: [{ ip: "1.1.1.1", ms: 80, ok: 1, fail: 0, unsupported: 0, nodes: [] }],
      totalResolved: 1,
    });
  });

  it("requires admin", async () => {
    mocks.getCurrentAdmin.mockResolvedValue(null);
    await expect(readJson(await POST(request({ address: "1.1.1.1", sourceId: "s1" })))).resolves.toMatchObject({
      status: 401,
    });
  });

  it("rejects missing address / sourceId", async () => {
    await expect(readJson(await POST(request({ sourceId: "s1" })))).resolves.toMatchObject({ status: 400 });
    await expect(readJson(await POST(request({ address: "1.1.1.1" })))).resolves.toMatchObject({ status: 400 });
  });

  it("posts nodes to mihomo preview", async () => {
    const nodes = [{ name: "日本", type: "vless" }];
    const result = await readJson(
      await POST(request({ address: "1.1.1.1", sourceId: "s1", nodes, mode: "replace", healthCheck: { maxDelayMs: 1500 } })),
    );
    expect(result.status).toBe(200);
    expect(mocks.previewCfPreferredByNodes).toHaveBeenCalledWith({
      address: "1.1.1.1",
      sourceId: "s1",
      nodes,
      healthCheck: { maxDelayMs: 1500 },
      mode: "replace",
    });
    expect(result.body.candidates[0].ip).toBe("1.1.1.1");
  });
});
