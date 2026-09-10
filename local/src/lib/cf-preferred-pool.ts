import {
  activePoolAddresses,
  DEFAULT_CF_PREFERRED_POOL,
  normalizeCfPreferredPoolConfig,
} from "@subboost/core/subscription/cf-preferred-pool";
import { isCfPreferredApiUrl } from "@subboost/core/subscription/cf-preferred";
import type { CfPreferredPoolConfig, CfPreferredPoolEntry } from "@subboost/core/types/config";
import { fetchCfPreferredCandidates, tcpingCandidates } from "@subboost/server-core/cf-preferred";
import { isPrivateOrReservedIp } from "@subboost/server-core/subscription/ssrf-ip";
import { prisma } from "./prisma";

export async function readCfPreferredPool(ownerId: string): Promise<CfPreferredPoolConfig> {
  const row = await prisma.localAdmin.findUnique({
    where: { id: ownerId },
    select: { cfPreferredPool: true },
  });
  return normalizeCfPreferredPoolConfig(row?.cfPreferredPool);
}

export async function loadEnabledCfPreferredPool(ownerId: string): Promise<CfPreferredPoolConfig | undefined> {
  const pool = await readCfPreferredPool(ownerId);
  return pool.enabled ? pool : undefined;
}

function sanitizePool(value: unknown): CfPreferredPoolConfig {
  const pool = normalizeCfPreferredPoolConfig(value);
  return {
    ...pool,
    entries: pool.entries.filter((entry) => !isPrivateOrReservedIp(entry.address)),
  };
}

export async function saveCfPreferredPool(ownerId: string, value: unknown): Promise<CfPreferredPoolConfig> {
  const pool = sanitizePool(value);
  await prisma.localAdmin.update({
    where: { id: ownerId },
    data: { cfPreferredPool: JSON.stringify(pool) },
  });
  return pool;
}

export async function resolveCfPreferredPoolAddress(address: string): Promise<{ ip: string; ms: number | null }[]> {
  const value = address.trim();
  if (!value || isPrivateOrReservedIp(value)) return [];
  const ips = await fetchCfPreferredCandidates(value);
  if (ips.length === 0) return [];
  return tcpingCandidates(ips.slice(0, 16));
}

export async function probeCfPreferredPool(ownerId: string): Promise<CfPreferredPoolConfig> {
  const pool = await readCfPreferredPool(ownerId);
  if (pool.entries.length === 0) {
    const lastProbe = {
      at: new Date().toISOString(),
      ok: 0,
      failed: 0,
      message: "入口池为空，跳过探活",
    };
    return saveCfPreferredPool(ownerId, { ...pool, lastProbe });
  }

  const resolved = await Promise.all(
    pool.entries.map(async (entry) => ({
      entry,
      ips: isCfPreferredApiUrl(entry.address) ? [] : await fetchCfPreferredCandidates(entry.address),
    })),
  );
  const uniqueIps = [...new Set(resolved.flatMap((item) => item.ips))];
  const ranked = uniqueIps.length > 0 ? await tcpingCandidates(uniqueIps) : [];
  const msByIp = new Map(ranked.map((item) => [item.ip, item.ms]));
  const now = new Date().toISOString();
  let ok = 0;
  let failed = 0;

  const entries: CfPreferredPoolEntry[] = resolved.map(({ entry, ips }) => {
    const ms =
      ips.length === 0
        ? null
        : ips.reduce<number | null>((best, ip) => {
            const current = msByIp.get(ip) ?? null;
            if (current === null) return best;
            if (best === null || current < best) return current;
            return best;
          }, null);
    if (ms === null) failed += 1;
    else ok += 1;
    return { ...entry, ms, probedAt: now };
  });

  return saveCfPreferredPool(ownerId, {
    ...pool,
    entries,
    lastProbe: {
      at: now,
      ok,
      failed,
      message: `探活完成：${ok} 通 / ${failed} 失败`,
    },
  });
}

export async function probeCfPreferredPoolEntry(
  ownerId: string,
  entryId: string,
): Promise<CfPreferredPoolConfig> {
  const pool = await readCfPreferredPool(ownerId);
  const target = pool.entries.find((e) => e.id === entryId || e.address === entryId);
  if (!target) return pool;

  const ips = isCfPreferredApiUrl(target.address) ? [] : await fetchCfPreferredCandidates(target.address);
  const ranked = ips.length > 0 ? await tcpingCandidates(ips) : [];
  const ms = ranked[0]?.ms ?? null;
  const now = new Date().toISOString();
  const updatedEntries = pool.entries.map((e) =>
    e.id === target.id ? { ...e, ms, probedAt: now } : e,
  );

  return saveCfPreferredPool(ownerId, { ...pool, entries: updatedEntries });
}

export { activePoolAddresses, DEFAULT_CF_PREFERRED_POOL };
