import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubscriptionResponse,
  deleteSubscriptionResponse,
  getSubscriptionIdFromQuery,
  getSubscriptionResponse,
  listSubscriptionsResponse,
  refreshSubscriptionResponse,
  updateSubscriptionResponse,
} from "./subscription-route-handlers";

const mocks = vi.hoisted(() => ({
  apiError: vi.fn(),
  createSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  getSubscription: vi.fn(),
  json: vi.fn(),
  jsonBodyError: vi.fn(),
  listSubscriptions: vi.fn(),
  readJsonBody: vi.fn(),
  refreshSubscription: vi.fn(),
  updateSubscription: vi.fn(),
  withCurrentAdmin: vi.fn(),
}));

vi.mock("@local/lib/api-auth", () => ({ withCurrentAdmin: mocks.withCurrentAdmin }));
vi.mock("@local/lib/http", () => ({
  apiError: mocks.apiError,
  json: mocks.json,
  jsonBodyError: mocks.jsonBodyError,
  LOCAL_JSON_BODY_LIMITS: { subscription: 16 * 1024 * 1024 },
  readJsonBody: mocks.readJsonBody,
}));
vi.mock("@local/lib/subscription-service", () => ({
  createSubscription: mocks.createSubscription,
  deleteSubscription: mocks.deleteSubscription,
  getSubscription: mocks.getSubscription,
  listSubscriptions: mocks.listSubscriptions,
  refreshSubscription: mocks.refreshSubscription,
  updateSubscription: mocks.updateSubscription,
}));

const request = new Request("http://localhost/api/subscriptions", { method: "POST" });

async function readNdjsonLines(response: Response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("local subscription route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withCurrentAdmin.mockImplementation(async (handler: (admin: { id: string }) => unknown) =>
      handler({ id: "admin-1" })
    );
    mocks.json.mockImplementation((body: unknown, status = 200) => ({ body, status }));
    mocks.apiError.mockImplementation((message: string, code: string, status: number) => ({ message, code, status }));
    mocks.jsonBodyError.mockImplementation(() => ({ message: "Invalid JSON body.", code: "BAD_REQUEST", status: 400 }));
  });

  it("extracts subscription ids from query strings", () => {
    expect(getSubscriptionIdFromQuery(new Request("http://localhost/api/subscriptions?id=%20sub-1%20"))).toBe("sub-1");
    expect(getSubscriptionIdFromQuery(new Request("http://localhost/api/subscriptions"))).toBe("");
  });

  it("lists and reads subscriptions for the current admin", async () => {
    mocks.listSubscriptions.mockResolvedValueOnce([{ id: "sub-1" }]);
    await expect(listSubscriptionsResponse()).resolves.toEqual({ body: { subscriptions: [{ id: "sub-1" }] }, status: 200 });
    expect(mocks.listSubscriptions).toHaveBeenCalledWith("admin-1");

    mocks.getSubscription.mockResolvedValueOnce({ id: "sub-1" });
    await expect(getSubscriptionResponse("sub-1")).resolves.toEqual({ body: { subscription: { id: "sub-1" } }, status: 200 });

    mocks.getSubscription.mockResolvedValueOnce(null);
    await expect(getSubscriptionResponse("missing")).resolves.toEqual({
      message: "Subscription not found.",
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("creates subscriptions with JSON response", async () => {
    mocks.readJsonBody.mockResolvedValueOnce({ ok: false, reason: "invalid_json" });
    await expect(createSubscriptionResponse(request)).resolves.toEqual({
      message: "Invalid JSON body.",
      code: "BAD_REQUEST",
      status: 400,
    });

    mocks.readJsonBody.mockResolvedValueOnce({ ok: true, value: { name: "A" } });
    mocks.createSubscription.mockResolvedValueOnce({ subscription: { id: "sub-1" }, nodes: [{}] });
    const created = await createSubscriptionResponse(request);
    expect(created).toEqual({
      body: { subscription: { id: "sub-1" }, nodes: [{}] },
      status: 200,
    });
    expect(mocks.createSubscription).toHaveBeenCalledWith("admin-1", { name: "A" });

    mocks.readJsonBody.mockResolvedValueOnce({ ok: true, value: { name: "" } });
    mocks.createSubscription.mockRejectedValueOnce(new Error("Name required"));
    const failed = await createSubscriptionResponse(request);
    expect(failed).toEqual({
      message: "Name required",
      code: "BAD_REQUEST",
      status: 400,
    });

    mocks.readJsonBody.mockResolvedValueOnce({ ok: true, value: { name: "" } });
    mocks.createSubscription.mockRejectedValueOnce("bad");
    const crashed = await createSubscriptionResponse(request);
    expect(crashed).toEqual({
      message: "保存失败",
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("updates subscriptions and validates JSON body shape", async () => {
    mocks.readJsonBody.mockResolvedValueOnce({ ok: true, value: [] });
    await expect(updateSubscriptionResponse(request, "sub-1")).resolves.toEqual({
      message: "Invalid JSON body.",
      code: "BAD_REQUEST",
      status: 400,
    });

    mocks.readJsonBody.mockResolvedValueOnce({ ok: true, value: { name: "B" } });
    mocks.getSubscription.mockResolvedValueOnce(null);
    await expect(updateSubscriptionResponse(request, "missing")).resolves.toEqual({
      message: "Subscription not found.",
      code: "NOT_FOUND",
      status: 404,
    });

    mocks.readJsonBody.mockResolvedValueOnce({ ok: true, value: { name: "B" } });
    mocks.getSubscription.mockResolvedValueOnce({ id: "sub-1" });
    mocks.updateSubscription.mockResolvedValueOnce({ subscription: { id: "sub-1", name: "B" }, nodes: [] });
    const updated = await updateSubscriptionResponse(request, "sub-1");
    expect(updated).toEqual({
      body: { subscription: { id: "sub-1", name: "B" }, nodes: [] },
      status: 200,
    });
    expect(mocks.updateSubscription).toHaveBeenCalledWith("admin-1", "sub-1", { name: "B" });

    mocks.readJsonBody.mockResolvedValueOnce({ ok: true, value: { name: "" } });
    mocks.getSubscription.mockResolvedValueOnce({ id: "sub-1" });
    mocks.updateSubscription.mockRejectedValueOnce(new Error("Update failed"));
    const failedUpdate = await updateSubscriptionResponse(request, "sub-1");
    expect(failedUpdate).toEqual({
      message: "Update failed",
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("deletes and refreshes subscriptions", async () => {
    mocks.deleteSubscription.mockResolvedValueOnce(false);
    await expect(deleteSubscriptionResponse("missing")).resolves.toEqual({
      message: "Subscription not found.",
      code: "NOT_FOUND",
      status: 404,
    });

    mocks.deleteSubscription.mockResolvedValueOnce(true);
    await expect(deleteSubscriptionResponse("sub-1")).resolves.toEqual({ body: { success: true }, status: 200 });

    // 订阅不存在：流外检查保持 JSON 404
    mocks.getSubscription.mockResolvedValueOnce(null);
    await expect(refreshSubscriptionResponse("missing")).resolves.toEqual({
      message: "Subscription not found.",
      code: "NOT_FOUND",
      status: 404,
    });

    // 刷新失败：error 流行
    mocks.getSubscription.mockResolvedValueOnce({ id: "sub-1" });
    mocks.refreshSubscription.mockResolvedValueOnce({ ok: false, response: { body: { error: "bad" }, status: 502 } });
    const failedRefresh = await refreshSubscriptionResponse("sub-1");
    expect(failedRefresh.status).toBe(200);
    expect(await readNdjsonLines(failedRefresh)).toEqual([{ type: "error", message: "bad" }]);

    // 刷新成功：health 进度行 + complete 行
    mocks.getSubscription.mockResolvedValueOnce({ id: "sub-1" });
    mocks.refreshSubscription.mockImplementationOnce(async (_ownerId, _id, onProgress) => {
      onProgress?.(1, 5);
      onProgress?.(5, 5);
      return { ok: true, body: { nodeCount: 2, healthStats: { tested: 5, ok: 3, fail: 2, unsupported: 0 } } };
    });
    const refreshed = await refreshSubscriptionResponse("sub-1");
    expect(refreshed.status).toBe(200);
    expect(await readNdjsonLines(refreshed)).toEqual([
      { type: "health", tested: 1, total: 5 },
      { type: "health", tested: 5, total: 5 },
      {
        type: "complete",
        value: { nodeCount: 2, healthStats: { tested: 5, ok: 3, fail: 2, unsupported: 0 } },
      },
    ]);
  });
});
