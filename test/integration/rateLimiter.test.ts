// Proves the hard per-key ceiling holds under concurrent load, that routing
// moves to other eligible keys, and that callers queue (not drop) when every
// key is exhausted.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../../src/db/pool.ts';
import { KeyPool } from '../../src/provider/keyPool.ts';
import { HealthWeightedHeadroomStrategy } from '../../src/provider/scheduling.ts';
import { freshDb } from '../support/db.ts';

process.env.LOG_SILENT = '1';

const KEYS = [1, 2, 3, 4].map((slot) => ({ id: `key_${slot}`, slot, secret: `nvapi-test-secret-${slot}-xxxxxxxxxxxx`, allowedModels: null }));

function pool(db: Db, windowMs: number, rpm = 55, maxInflight = 64) {
  return new KeyPool(db, KEYS, {
    rpmPerKey: rpm,
    windowMs,
    maxInflightPerKey: maxInflight,
    leaseTtlMs: 120_000,
    strategy: new HealthWeightedHeadroomStrategy(),
  });
}

/** Max number of grants for one key inside any rolling window of `windowMs`. */
function maxInAnyWindow(times: number[], windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] >= windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

describe('NVIDIA key pool rate limiter', () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  after(async () => {
    await db.end();
  });

  it('never grants more than 55 requests per rolling 60s window per key under 260 concurrent callers, and queues the overflow', async () => {
    await db.query('TRUNCATE key_requests');
    const kp = pool(db, 60_000);
    await kp.sync();
    const results: Array<{ keyId: string } | 'waiting'> = [];
    const controller = new AbortController();
    const all = Array.from({ length: 260 }, (_, i) =>
      kp
        .acquire({ model: 'm', requesterId: `r${i}`, maxWaitMs: 120_000, signal: controller.signal })
        .then((l) => results.push({ keyId: l.keyId }))
        .catch(() => results.push('waiting')),
    );
    // Let the first wave settle; the 40 overflow requests must still be queued, not dropped.
    const deadline = Date.now() + 20_000;
    while (results.length < 220 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1_500));
    const granted = results.filter((r): r is { keyId: string } => r !== 'waiting');
    assert.equal(granted.length, 220, 'exactly 4 x 55 grants inside the first window');
    const perKey: Record<string, number> = {};
    for (const g of granted) perKey[g.keyId] = (perKey[g.keyId] ?? 0) + 1;
    assert.deepEqual(perKey, { key_1: 55, key_2: 55, key_3: 55, key_4: 55 });
    assert.equal(kp.waitingCount, 40, 'overflow callers are queued');
    const snaps = await kp.snapshots();
    for (const s of snaps) {
      assert.equal(s.windowCount, 55);
      assert.equal(s.remaining, 0);
      assert.equal(s.health, 'exhausted');
    }
    // Ledger agrees with the in-memory results.
    const { rows } = await db.query(`SELECT key_id, count(*)::int AS n FROM key_requests GROUP BY key_id ORDER BY key_id`);
    assert.deepEqual(rows.map((r) => r.n), [55, 55, 55, 55]);
    controller.abort();
    await Promise.allSettled(all);
  });

  it('holds the ceiling across many rolling windows (sliding-window audit of every grant)', async () => {
    await db.query('TRUNCATE key_requests');
    const windowMs = 1_500;
    const kp = pool(db, windowMs);
    await kp.sync();
    const N = 1_000;
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const lease = await kp.acquire({ model: 'm', requesterId: `s${i}`, maxWaitMs: 120_000 });
        await kp.complete(lease, { status: 'ok', httpStatus: 200, latencyMs: 5 });
      }),
    );
    const { rows } = await db.query(`SELECT key_id, extract(epoch from granted_at) * 1000 AS t FROM key_requests`);
    assert.equal(rows.length, N, 'every request was eventually served (none dropped)');
    const byKey: Record<string, number[]> = {};
    for (const r of rows) (byKey[r.key_id] ??= []).push(Number(r.t));
    for (const [key, times] of Object.entries(byKey)) {
      const peak = maxInAnyWindow(times, windowMs);
      assert.ok(peak <= 55, `${key} peaked at ${peak} grants inside a ${windowMs}ms window`);
    }
    assert.equal(Object.keys(byKey).length, 4, 'load spread over all four keys');
  });

  it('routes to the healthiest key with capacity (53/55, 12/55, cooldown, 27/55 -> key_2)', async () => {
    await db.query('TRUNCATE key_requests');
    const kp = pool(db, 60_000);
    await kp.sync();
    const fill = async (key: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await db.query(
          `INSERT INTO key_requests (lease_id, key_id, granted_at, model, status, latency_ms) VALUES ($1, $2, clock_timestamp(), 'm', 'ok', 900)`,
          [`fill-${key}-${i}`, key],
        );
      }
    };
    await fill('key_1', 53);
    await fill('key_2', 12);
    await fill('key_4', 27);
    await db.query(`UPDATE nvidia_keys SET cooldown_until = now() + interval '30 seconds' WHERE id = 'key_3'`);
    const d = await kp.tryAcquire({ model: 'm', requesterId: 'pick' });
    assert.ok(d.granted);
    assert.equal(d.lease.keyId, 'key_2');
    await db.query(`UPDATE nvidia_keys SET cooldown_until = NULL`);
  });

  it('skips a full key and a cooling-down key, and reports a wait hint when all are unavailable', async () => {
    await db.query('TRUNCATE key_requests');
    const kp = pool(db, 60_000, 2);
    await kp.sync();
    await db.query(`UPDATE nvidia_keys SET cooldown_until = now() + interval '5 seconds' WHERE id IN ('key_3', 'key_4')`);
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = await kp.tryAcquire({ model: 'm', requesterId: `x${i}` });
      assert.ok(d.granted, `grant ${i}`);
      got.push(d.lease.keyId);
    }
    assert.deepEqual([...got].sort(), ['key_1', 'key_1', 'key_2', 'key_2']);
    const d = await kp.tryAcquire({ model: 'm', requesterId: 'x-over' });
    assert.equal(d.granted, false);
    if (!d.granted) {
      assert.equal(d.reason, 'cooldown');
      assert.ok(d.retryAfterMs > 3_000 && d.retryAfterMs <= 5_000, `wait hint ${d.retryAfterMs}`);
    }
    await db.query(`UPDATE nvidia_keys SET cooldown_until = NULL`);
  });

  it('respects per-key model allowlists (model compatibility)', async () => {
    await db.query('TRUNCATE key_requests');
    const keys = KEYS.map((k) => ({ ...k, allowedModels: k.slot === 3 ? ['vision-model'] : ['text-model'] }));
    const kp = new KeyPool(db, keys, { rpmPerKey: 55, windowMs: 60_000, maxInflightPerKey: 8, leaseTtlMs: 60_000, strategy: new HealthWeightedHeadroomStrategy() });
    await kp.sync();
    for (let i = 0; i < 5; i++) {
      const d = await kp.tryAcquire({ model: 'vision-model', requesterId: `v${i}` });
      assert.ok(d.granted && d.lease.keyId === 'key_3');
    }
    const none = await kp.tryAcquire({ model: 'unknown-model', requesterId: 'u' });
    assert.equal(none.granted, false);
    if (!none.granted) assert.equal(none.reason, 'no_compatible_key');
  });

  it('never stores or returns key secrets', async () => {
    const kp = pool(db, 60_000);
    await kp.sync();
    const { rows } = await db.query('SELECT * FROM nvidia_keys');
    const dump = JSON.stringify(rows) + JSON.stringify(await kp.snapshots());
    for (const k of KEYS) assert.ok(!dump.includes(k.secret), 'secret leaked into DB or snapshots');
  });
});
