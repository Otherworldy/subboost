import type { SubscriptionSource } from "@subboost/ui/store/config-store";

export type SourceOrderDirection = "up" | "down";

export function moveSubscriptionSource(
  sources: SubscriptionSource[],
  sourceId: string,
  direction: SourceOrderDirection
): SubscriptionSource[] {
  const currentIndex = sources.findIndex((source) => source.id === sourceId);
  if (currentIndex < 0) return sources;

  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= sources.length) return sources;

  const nextSources = [...sources];
  [nextSources[currentIndex], nextSources[targetIndex]] = [nextSources[targetIndex], nextSources[currentIndex]];
  return nextSources;
}

// 拖拽排序：把 sourceId 移动到 targetSourceId 所在位置（插入，非交换）
export function moveSubscriptionSourceTo(
  sources: SubscriptionSource[],
  sourceId: string,
  targetSourceId: string
): SubscriptionSource[] {
  const fromIndex = sources.findIndex((source) => source.id === sourceId);
  const toIndex = sources.findIndex((source) => source.id === targetSourceId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return sources;

  const nextSources = [...sources];
  const [moved] = nextSources.splice(fromIndex, 1);
  nextSources.splice(toIndex, 0, moved);
  return nextSources;
}

// 节点按所属源的顺序重排：以最早所属源（index 最小）为准，同源保持原顺序（稳定排序）；
// 无源节点排在最后。
export function sortNodesBySourceOrder<T>(
  nodes: T[],
  sources: Array<{ id: string }>,
  getSourceIds: (node: T) => string[]
): T[] {
  const indexBySourceId = new Map(sources.map((source, index) => [source.id, index]));
  const rank = (node: T): number => {
    const ids = getSourceIds(node);
    if (ids.length === 0) return sources.length;
    let min = sources.length;
    for (const id of ids) {
      const index = indexBySourceId.get(id);
      if (index !== undefined && index < min) min = index;
    }
    return min;
  };
  return [...nodes].sort((a, b) => rank(a) - rank(b));
}
