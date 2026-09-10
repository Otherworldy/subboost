import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    localAdmin: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  fetchCfPreferredCandidates: vi.fn(),
  tcpingCandidates: vi.fn(),
}));

vi.mock("./prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@subboost/server-core/cf-preferred", () => ({
  fetchCfPreferredCandidates: mocks.fetchCfPreferredCandidates,
  tcpingCandidates: mocks.tcpingCandidates,
}));

import {
  loadEnabledCfPreferredPool,
  probeCfPreferredPool,
  readCfPreferredPool,
  saveCfPreferredPool,
} from "./cf-preferred-pool";

describe("local cf preferred pool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.localAdmin.update.mockImplementation(async ({ data }: { data: { cfPreferredPool: string } }) => ({
      cfPreferredPool: data.cfPreferredPool,
    }));
  });

  it("read：空字段返回默认关闭池；enabled 才 load", async () => {
    mocks.prisma.localAdmin.findUnique.mockResolvedValueOnce({ cfPreferredPool: null });
    await expect(readCfPreferredPool("admin-1")).resolves.toMatchObject({ enabled: false, entries: [] });
    mocks.prisma.localAdmin.findUnique.mockResolvedValueOnce({
      cfPreferredPool: JSON.stringify({
        enabled: true,
        entries: [{ address: "1.1.1.1", carrier: "telecom", enabled: true }],
      }),
    });
    await expect(loadEnabledCfPreferredPool("admin-1")).resolves.toMatchObject({ enabled: true });
    mocks.prisma.localAdmin.findUnique.mockResolvedValueOnce({ cfPreferredPool: null });
    await expect(loadEnabledCfPreferredPool("admin-1")).resolves.toBeUndefined();
  });

  it("save 过滤内网地址", async () => {
    const saved = await saveCfPreferredPool("admin-1", {
      enabled: true,
      entries: [
        { address: "10.0.0.1", carrier: "telecom", enabled: true },
        { address: "1.1.1.1", carrier: "telecom", enabled: true },
      ],
    });
    expect(saved.entries.map((e) => e.address)).toEqual(["1.1.1.1"]);
    expect(mocks.prisma.localAdmin.update).toHaveBeenCalled();
  });

  it("probe：只更新延迟，不改启用状态", async () => {
    mocks.prisma.localAdmin.findUnique.mockResolvedValueOnce({
      cfPreferredPool: JSON.stringify({
        enabled: true,
        entries: [
          { id: "a", address: "1.1.1.1", carrier: "telecom", enabled: true },
          { id: "b", address: "2.2.2.2", carrier: "unicom", enabled: false },
        ],
      }),
    });
    mocks.fetchCfPreferredCandidates.mockImplementation(async (address: string) => [address]);
    mocks.tcpingCandidates.mockResolvedValueOnce([
      { ip: "1.1.1.1", ms: null },
      { ip: "2.2.2.2", ms: 120 },
    ]);

    const probed = await probeCfPreferredPool("admin-1");
    expect(probed.entries[0]).toMatchObject({ address: "1.1.1.1", enabled: true, ms: null });
    expect(probed.entries[1]).toMatchObject({ address: "2.2.2.2", enabled: false, ms: 120 });
    expect(probed.lastProbe).toMatchObject({ ok: 1, failed: 1 });
  });
});
