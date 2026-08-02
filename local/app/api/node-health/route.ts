import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";
import { runNodeHealthChecks, type NodeHealthCheckScope } from "@local/lib/node-health-service";
import { persistNodeHealthResults } from "@local/lib/subscription-service";

type HealthStreamMessage =
  | { type: "result"; name: string; sourceId: string; result: unknown }
  | { type: "done"; summary: { tested: number; ok: number; fail: number; unsupported: number } }
  | { type: "error"; message: string };

function streamMessage(message: HealthStreamMessage): string {
  return `${JSON.stringify(message)}\n`;
}
function parseScope(body: Record<string, unknown>): NodeHealthCheckScope | null {
  const raw = body.scope;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "all") return { kind: "all" };
  if (kind === "source") {
    const sourceId = typeof record.sourceId === "string" ? record.sourceId.trim() : "";
    if (!sourceId) return null;
    return { kind: "source", sourceId };
  }
  if (kind === "node") {
    const nodeName = typeof record.nodeName === "string" ? record.nodeName.trim() : "";
    if (!nodeName) return null;
    return { kind: "node", nodeName };
  }
  return null;
}

export async function POST(request: Request) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.subscription);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const body = parsedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError("Invalid JSON body.", "BAD_REQUEST", 400);
    }

    const scope = parseScope(body as Record<string, unknown>);
    if (!scope) {
      return apiError("Invalid health check scope.", "BAD_REQUEST", 400);
    }
    const subscriptionId =
      typeof (body as Record<string, unknown>).subscriptionId === "string"
        ? ((body as Record<string, unknown>).subscriptionId as string).trim()
        : "";

    try {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const result = await runNodeHealthChecks({
              nodes: (body as Record<string, unknown>).nodes,
              sources: (body as Record<string, unknown>).sources,
              scope,
              onNodeResult: (name, sourceId, nodeResult) => {
                controller.enqueue(
                  encoder.encode(streamMessage({ type: "result", name, sourceId, result: nodeResult }))
                );
              },
            });
            // 正在编辑已保存订阅时，把手动测活结果落库，下游订阅链接立即过滤不通节点
            if (subscriptionId) {
              const persisted = await persistNodeHealthResults(admin.id, subscriptionId, result.nodes);
              if (!persisted) {
                throw new Error("测活完成，但订阅不存在或已被删除，结果未持久化");
              }
            }
            controller.enqueue(encoder.encode(streamMessage({ type: "done", summary: result.summary })));
          } catch (error) {
            controller.enqueue(
              encoder.encode(streamMessage({ type: "error", message: error instanceof Error ? error.message : "测活失败" }))
            );
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
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "测活失败", "BAD_REQUEST", 400);
    }
  });
}
