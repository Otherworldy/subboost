import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";
import {
  probeCfPreferredPool,
  probeCfPreferredPoolEntry,
  readCfPreferredPool,
  resolveCfPreferredPoolAddress,
  saveCfPreferredPool,
} from "@local/lib/cf-preferred-pool";
import { prisma } from "@local/lib/prisma";

export async function GET() {
  return withCurrentAdmin(async (admin) => {
    const [pool, subscriptionCount] = await Promise.all([
      readCfPreferredPool(admin.id),
      prisma.subscription.count({ where: { ownerId: admin.id } }),
    ]);
    return json({ pool, subscriptionCount });
  });
}

export async function PUT(request: Request) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.small);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const body = parsedBody.value;
    const raw =
      body && typeof body === "object" && !Array.isArray(body) && "pool" in body
        ? (body as { pool: unknown }).pool
        : body;
    const pool = await saveCfPreferredPool(admin.id, raw);
    return json({ pool });
  });
}

export async function POST(request: Request) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.small);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const body = parsedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError("Invalid JSON body.", "BAD_REQUEST", 400);
    }
    const record = body as Record<string, unknown>;
    const action = typeof record.action === "string" ? record.action.trim() : "";

    if (action === "probe") {
      const entryId = typeof record.entryId === "string" ? record.entryId.trim() : undefined;
      const pool = entryId
        ? await probeCfPreferredPoolEntry(admin.id, entryId)
        : await probeCfPreferredPool(admin.id);
      return json({ pool });
    }

    if (action === "resolve") {
      const address = typeof record.address === "string" ? record.address.trim() : "";
      if (!address) return apiError("address is required.", "VALIDATION_ERROR", 400);
      if (address.length > 2048) return apiError("address is too long.", "VALIDATION_ERROR", 400);
      const candidates = await resolveCfPreferredPoolAddress(address);
      return json({ candidates });
    }

    return apiError("action must be probe or resolve.", "VALIDATION_ERROR", 400);
  });
}
