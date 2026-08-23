import { describe, expect, it } from "vitest";
import { normalizeSavedSourcesForPersistence } from "./saved-sources";

describe("normalizeSavedSourcesForPersistence", () => {
  it("normalizes URL sources and preserves supported source metadata", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        {
          id: " src-1 ",
          type: "url",
          content: " https://example.com/sub&token=abc ",
          useProxyProviders: true,
          userinfoUrl: " https://info.example/user&token=abc ",
          userinfoUserAgent: " LocalAgent/1.0 ",
          subscriptionUserInfo: {
            upload: 1024,
            download: -1,
            total: 4096,
            expire: 1893456000,
          },
          tag: " premium ",
          nameTemplate: " {name} ",
          lastParsedContent: " https://old.example/sub&token=old ",
          lastParsedTag: " old-tag ",
          lastParsedNameTemplate: " old-{name} ",
        },
      ])
    ).toEqual([
      {
        id: "src-1",
        type: "url",
        content: "https://example.com/sub?token=abc",
        useProxyProviders: true,
        userinfoUrl: "https://info.example/user?token=abc",
        userinfoUserAgent: "LocalAgent/1.0",
        subscriptionUserInfo: {
          upload: 1024,
          total: 4096,
          expire: 1893456000,
        },
        tag: "premium",
        nameTemplate: "{name}",
        lastParsedContent: "https://old.example/sub?token=old",
        lastParsedTag: "old-tag",
        lastParsedNameTemplate: "old-{name}",
      },
    ]);
  });

  it("creates fallback URL sources when no saved sources are valid", () => {
    expect(
      normalizeSavedSourcesForPersistence([{ id: "bad", type: "url", content: "   " }], {
        fallbackUrls: [" https://fallback.example/sub ", "", 42],
      })
    ).toEqual([
      {
        id: "source_1",
        type: "url",
        content: "https://fallback.example/sub",
        lastParsedContent: "https://fallback.example/sub",
      },
    ]);
  });

  it("splits multi-line URL sources while keeping stable preferred ids", () => {
    expect(
      normalizeSavedSourcesForPersistence(
        [
          {
            id: "src-1",
            type: "url",
            content: "https://a.example/sub\n\n https://b.example/sub ",
            userinfoUserAgent: "Agent/1.0",
            tag: "tag-a",
            nameTemplate: "{name}",
          },
        ],
        {
          idFactory: () => "generated-id",
          splitUrlLines: true,
        }
      )
    ).toEqual([
      {
        id: "src-1",
        type: "url",
        content: "https://a.example/sub",
        userinfoUserAgent: "Agent/1.0",
        tag: "tag-a",
        nameTemplate: "{name}",
      },
      {
        id: "src-1-2",
        type: "url",
        content: "https://b.example/sub",
        userinfoUserAgent: "Agent/1.0",
        tag: "tag-a",
        nameTemplate: "{name}",
      },
    ]);
  });

  it("deduplicates repeated preferred ids across valid sources", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        { id: "same", type: "yaml", content: "proxies: []" },
        { id: "same", type: "nodes", content: "[]" },
      ]).map((source) => source.id)
    ).toEqual(["same", "same-2"]);
  });

  it("preserves normalized health check settings for all source types", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        {
          id: "url-src",
          type: "url",
          content: "https://example.com/sub",
          healthCheck: {
            enabled: true,
            url: "www.google.com",
            maxDelayMs: 1200,
            concurrency: 8,
          },
        },
        {
          id: "yaml-src",
          type: "yaml",
          content: "proxies: []",
          healthCheck: { enabled: true },
        },
        {
          id: "nodes-src",
          type: "nodes",
          content: "trojan://secret@example.com:443#Node",
          healthCheck: { enabled: true },
        },
      ])
    ).toEqual([
      {
        id: "url-src",
        type: "url",
        content: "https://example.com/sub",
        healthCheck: {
          enabled: true,
          url: "https://www.google.com/",
          maxDelayMs: 1200,
          concurrency: 8,
        },
      },
      {
        id: "yaml-src",
        type: "yaml",
        content: "proxies: []",
        healthCheck: { enabled: true },
      },
      {
        id: "nodes-src",
        type: "nodes",
        content: "trojan://secret@example.com:443#Node",
        healthCheck: { enabled: true },
      },
    ]);
  });

  it("drops invalid health check values and clears it in proxy-providers mode", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        {
          id: "bad",
          type: "nodes",
          content: "trojan://secret@example.com:443#Node",
          healthCheck: { enabled: true, url: "ftp://example.com", maxDelayMs: 5, concurrency: 500 },
        },
        {
          id: "provider",
          type: "url",
          content: "https://example.com/sub",
          useProxyProviders: true,
          healthCheck: { enabled: true, url: "https://www.google.com" },
        },
      ])
    ).toEqual([
      {
        id: "bad",
        type: "nodes",
        content: "trojan://secret@example.com:443#Node",
        healthCheck: { enabled: true },
      },
      {
        id: "provider",
        type: "url",
        content: "https://example.com/sub",
        useProxyProviders: true,
      },
    ]);
  });

  it("drops empty or invalid source subscription userinfo", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        {
          id: "empty",
          type: "yaml",
          content: "proxies: []",
          subscriptionUserInfo: { upload: -1, expire: 1 },
        },
        {
          id: "bad",
          type: "nodes",
          content: "trojan://secret@example.com:443#Node",
          subscriptionUserInfo: "upload=1",
        },
      ])
    ).toEqual([
      {
        id: "empty",
        type: "yaml",
        content: "proxies: []",
      },
      {
        id: "bad",
        type: "nodes",
        content: "trojan://secret@example.com:443#Node",
      },
    ]);
  });

  it("persists per-source CF preferred config", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        {
          id: "src-cf",
          type: "url",
          content: "https://example.com/sub",
          cfPreferred: { enabled: true, address: " cf.090227.xyz ", mode: "replace" },
        },
        {
          id: "src-off",
          type: "nodes",
          content: "ss://x",
          cfPreferred: { enabled: false },
        },
      ])
    ).toEqual([
      {
        id: "src-cf",
        type: "url",
        content: "https://example.com/sub",
        cfPreferred: { enabled: true, address: "cf.090227.xyz", mode: "replace" },
      },
      {
        id: "src-off",
        type: "nodes",
        content: "ss://x",
      },
    ]);
  });
});
