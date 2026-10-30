import { expect, test } from 'bun:test';
import { ingest } from './ingest.ts';
import type { Env } from './env.ts';

test('catch-up ingestion chunks old-bucket lookups within D1 limits and publishes before advancing', async () => {
  const requests: number[][] = [];
  const written: string[] = [];
  const events: string[] = [];
  const DB = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          if (args.length > 100) throw new Error('D1 parameter limit exceeded');
          return statement;
        },
        async first() {
          return sql.includes('count(*)') ? { n: 125 } : { value: '1000' };
        },
        async all() {
          if (sql.includes('SELECT DISTINCT bucket')) {
            requests.push(values as number[]);
            return { results: [{ bucket: 42 }] };
          }
          return { results: [] };
        },
        async run() { events.push('watermark'); }
      };
      return statement;
    },
    async batch() { events.push('batch'); }
  };
  const INDEX = { async put(key: string) { written.push(key); events.push(key); } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/maxitem.json')) return Response.json(1125);
    if (url.endsWith('/updates.json')) return Response.json({ items: [] });
    const id = Number(url.match(/item\/(\d+)/)?.[1]);
    return Response.json({ id, type: 'story', url: `https://example.com/${id}`, title: `Story ${id}`, time: 1785500000 });
  }) as typeof fetch;
  try {
    const result = await ingest({ DB, INDEX } as unknown as Env);
    expect(requests.map((ids) => ids.length)).toEqual([100, 25]);
    expect(requests.flat()).toEqual(Array.from({ length: 125 }, (_, i) => 1001 + i));
    expect(written).toContain('b/002a.json');
    expect(events.indexOf('b/002a.json')).toBeGreaterThan(events.lastIndexOf('batch'));
    expect(events.slice(-3)).toEqual(['recent.json', 'manifest.json', 'watermark']);
    expect(result.watermark).toBe(1125);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
