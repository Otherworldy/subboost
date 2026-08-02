import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  refreshSubscription,
  updateSubscription,
} from "@local/lib/subscription-service";

export function getSubscriptionIdFromQuery(request: Request): string {
  return new URL(request.url).searchParams.get("id")?.trim() || "";
}

export async function listSubscriptionsResponse() {
  return withCurrentAdmin(async (admin) => json({ subscriptions: await listSubscriptions(admin.id) }));
}

type SaveStreamMessage =
  | { type: "health"; tested: number; total: number }
  | { type: "complete"; value: unknown }
  | { type: "error"; message: string };

function encodeSaveStreamLine(message: SaveStreamMessage): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

function streamSubscriptionResponse(run: (onProgress: (tested: number, total: number) => void) => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await run((tested, total) => {
          controller.enqueue(encodeSaveStreamLine({ type: "health", tested, total }));
        });
        controller.enqueue(encodeSaveStreamLine({ type: "complete", value: result }));
      } catch (error) {
        controller.enqueue(encodeSaveStreamLine({ type: "error", message: error instanceof Error ? error.message : "保存失败" }));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function createSubscriptionResponse(request: Request) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.subscription);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);

    const body = parsedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError("Invalid JSON body.", "BAD_REQUEST", 400);
    }
    return streamSubscriptionResponse((onProgress) => createSubscription(admin.id, body, onProgress));
  });
}

export async function getSubscriptionResponse(id: string) {
  return withCurrentAdmin(async (admin) => {
    const subscription = await getSubscription(admin.id, id);
    if (!subscription) return apiError("Subscription not found.", "NOT_FOUND", 404);
    return json({ subscription });
  });
}

export async function updateSubscriptionResponse(request: Request, id: string) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.subscription);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const body = parsedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError("Invalid JSON body.", "BAD_REQUEST", 400);
    }

    // 流外先确认订阅存在（避免在流内重复执行测活/写库）；404 保持 JSON 语义
    const existing = await getSubscription(admin.id, id);
    if (!existing) return apiError("Subscription not found.", "NOT_FOUND", 404);
    return streamSubscriptionResponse((onProgress) => updateSubscription(admin.id, id, body, onProgress));
  });
}

export async function deleteSubscriptionResponse(id: string) {
  return withCurrentAdmin(async (admin) => {
    const deleted = await deleteSubscription(admin.id, id);
    if (!deleted) return apiError("Subscription not found.", "NOT_FOUND", 404);
    return json({ success: true });
  });
}

export async function refreshSubscriptionResponse(id: string) {
  return withCurrentAdmin(async (admin) => {
    // 流外确认订阅存在（避免在流内重复执行刷新）；404 保持 JSON 语义
    const existing = await getSubscription(admin.id, id);
    if (!existing) return apiError("Subscription not found.", "NOT_FOUND", 404);
    return streamSubscriptionResponse(async (onProgress) => {
      const result = await refreshSubscription(admin.id, id, onProgress);
      if (!result) throw new Error("刷新失败：订阅不存在");
      if (!result.ok) throw new Error(result.response.body.error || "刷新失败");
      return result.body;
    });
  });
}
