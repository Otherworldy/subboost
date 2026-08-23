import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";
import { previewCfPreferredByNodes } from "@local/lib/cf-preferred-preview";
import { normalizeSourceHealthCheck } from "@subboost/core/subscription/node-health";

/**
 * CF 优选预览：解析候选 IP，把它们写进该源可套 CF 的节点，用 mihomo 测真实延迟。
 * POST /api/cf-preferred/preview  { address, sourceId, nodes, healthCheck?, mode? }
 */
export async function POST(request: Request) {
  return withCurrentAdmin(async () => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.subscription);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const body = parsedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError("Invalid JSON body.", "BAD_REQUEST", 400);
    }
    const record = body as Record<string, unknown>;
    const address = typeof record.address === "string" ? record.address.trim() : "";
    const sourceId = typeof record.sourceId === "string" ? record.sourceId.trim() : "";
    if (!address) return apiError("address is required.", "VALIDATION_ERROR", 400);
    if (address.length > 2048) return apiError("address is too long.", "VALIDATION_ERROR", 400);
    if (!sourceId) return apiError("sourceId is required.", "VALIDATION_ERROR", 400);

    try {
      const result = await previewCfPreferredByNodes({
        address,
        sourceId,
        nodes: record.nodes,
        healthCheck: normalizeSourceHealthCheck(record.healthCheck),
        mode: record.mode === "replace" ? "replace" : "clone",
      });
      return json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "CF preferred preview failed.";
      return apiError(message, "INTERNAL_ERROR", 502);
    }
  });
}
