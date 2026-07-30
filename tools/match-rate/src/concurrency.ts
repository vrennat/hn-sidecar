/** Runs `worker` over `items` with a bounded number of in-flight tasks, preserving order. */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;

  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
      done += 1;
      onProgress?.(done, items.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
};
