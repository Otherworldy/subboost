import { describe, expect, it } from "vitest";
import { moveSubscriptionSource, moveSubscriptionSourceTo, sortNodesBySourceOrder } from "./source-order";

describe("moveSubscriptionSource", () => {
  const sources = [
    { id: "a", content: "A" },
    { id: "b", content: "B" },
    { id: "c", content: "C" },
  ] as any[];

  it("moves sources up and down without mutating the input array", () => {
    expect(moveSubscriptionSource(sources, "b", "up").map((source) => source.id)).toEqual(["b", "a", "c"]);
    expect(moveSubscriptionSource(sources, "b", "down").map((source) => source.id)).toEqual(["a", "c", "b"]);
    expect(sources.map((source) => source.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the original array for missing or boundary moves", () => {
    expect(moveSubscriptionSource(sources, "missing", "up")).toBe(sources);
    expect(moveSubscriptionSource(sources, "a", "up")).toBe(sources);
    expect(moveSubscriptionSource(sources, "c", "down")).toBe(sources);
  });
});

describe("sortNodesBySourceOrder", () => {
  const sources = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const getSourceIds = (node: { id: string; src: string[] }) => node.src;

  it("groups nodes by owning source in source order", () => {
    const nodes = [
      { id: "n1", src: ["b"] },
      { id: "n2", src: ["a"] },
      { id: "n3", src: ["c"] },
      { id: "n4", src: ["a"] },
    ];

    const sorted = sortNodesBySourceOrder(nodes, sources, getSourceIds);

    expect(sorted.map((node) => node.id)).toEqual(["n2", "n4", "n1", "n3"]);
  });

  it("uses the earliest owning source for multi-source nodes and keeps manual nodes last", () => {
    const nodes = [
      { id: "manual", src: [] },
      { id: "multi", src: ["c", "a"] },
      { id: "a1", src: ["a"] },
    ];

    const sorted = sortNodesBySourceOrder(nodes, sources, getSourceIds);

    // multi 最早所属源是 a（index 0），与 a1 同组，稳定排序保持原相对顺序
    expect(sorted.map((node) => node.id)).toEqual(["multi", "a1", "manual"]);
  });

  it("does not mutate the input array", () => {
    const nodes = [{ id: "n1", src: ["b"] }, { id: "n2", src: ["a"] }];

    sortNodesBySourceOrder(nodes, sources, getSourceIds);

    expect(nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
  });
});

describe("moveSubscriptionSourceTo", () => {
  const sources = [
    { id: "a", content: "A" },
    { id: "b", content: "B" },
    { id: "c", content: "C" },
  ] as any[];

  it("moves a source to the target position (insert, not swap)", () => {
    expect(moveSubscriptionSourceTo(sources, "c", "a").map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(moveSubscriptionSourceTo(sources, "a", "c").map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(moveSubscriptionSourceTo(sources, "b", "a").map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("returns the original array for missing or same-position moves", () => {
    expect(moveSubscriptionSourceTo(sources, "missing", "a")).toBe(sources);
    expect(moveSubscriptionSourceTo(sources, "a", "missing")).toBe(sources);
    expect(moveSubscriptionSourceTo(sources, "a", "a")).toBe(sources);
  });
});
