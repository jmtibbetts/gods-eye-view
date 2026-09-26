// OVERPASS PROXY — which upstream answers count as an answer.
//
// One predicate governs cache reads, writes, and stale fallback. A mirror's
// refusal must neither end the search for healthy alternatives nor persist as
// data under the week/month-long cache TTLs. These cases use no live providers.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import createViteConfig, { fetchOverpassPayload, overpassPayloadIsData, readOverpassDisk, sanitizeOverpassBody, overpassBudgetMs, OVERPASS_TIMEOUT_MS, OVERPASS_MIN_ATTEMPT_MS, OVERPASS_UPSTREAMS } from '../vite.config.js';

const ENDPOINTS = ['https://a.example/api', 'https://b.example/api', 'https://c.example/api'];

/** Answer each endpoint from a map of url → {status, body}; record the order. */
function mirrors(byUrl) {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    const answer = byUrl[url];
    if (answer instanceof Error) throw answer;
    return { status: answer.status, headers: { get: () => answer.contentType || 'application/json' } };
  };
  return { fetchImpl, tried, readBody: async (_, __) => byUrl[tried[tried.length - 1]]?.body ?? '' };
}

const run = (byUrl) => {
  const m = mirrors(byUrl);
  return fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    fetchImpl: m.fetchImpl,
    readBody: m.readBody,
    simplify: (body) => body,
  }).then((payload) => ({ payload, tried: m.tried }), (error) => ({ error, tried: m.tried }));
};

const DATA = { status: 200, body: '{"elements":[]}' };

test('disk cache rejects old refusals for fresh and stale reads but preserves last-good data', async () => {
  const key = `overpass-cache-regression-${randomUUID()}`;
  const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
  const file = path.join(directory, `${createHash('sha1').update(key).digest('hex')}.json`);
  await mkdir(directory, { recursive: true });
  try {
    for (const refusal of [
      { status: 406 }, { status: 429 }, { status: 503 },
      { status: 200, rateLimited: true }, { status: 200, runtimeError: true },
    ]) {
      await writeFile(file, JSON.stringify({ ...DATA, cachedAt: Date.now(), ...refusal }));
      assert.equal(await readOverpassDisk(key, 60000), null, `fresh ${JSON.stringify(refusal)}`);
      assert.equal(await readOverpassDisk(key, Infinity), null, `stale ${JSON.stringify(refusal)}`);
    }
    const good = { ...DATA, cachedAt: Date.now() - 120000 };
    await writeFile(file, JSON.stringify(good));
    assert.equal(await readOverpassDisk(key, 60000), null, 'expired good data misses normal TTL');
    assert.deepEqual(await readOverpassDisk(key, Infinity), good, 'last-good data survives an outage');
    await writeFile(file, '{invalid');
    assert.equal(await readOverpassDisk(key, Infinity), null, 'corrupt cache is ignored');
  } finally {
    await unlink(file);
  }
});

// ── The predicate ────────────────────────────────────────────────────────────

test('only a 2xx that is neither rate-limited nor a runtime error is data', () => {
  assert.equal(overpassPayloadIsData({ status: 200 }), true);
  assert.equal(overpassPayloadIsData({ status: 204 }), true);

  // The measured refusal, and its neighbours. `< 500` admitted every one.
  for (const status of [400, 403, 406, 410, 429]) {
    assert.equal(overpassPayloadIsData({ status }), false, `${status} is not data`);
  }
  assert.equal(overpassPayloadIsData({ status: 502 }), false);
  // A 200 can still not be data: Overpass reports runtime failures in the body.
  assert.equal(overpassPayloadIsData({ status: 200, runtimeError: true }), false);
  assert.equal(overpassPayloadIsData({ status: 200, rateLimited: true }), false);
  assert.equal(overpassPayloadIsData({}), false);
  assert.equal(overpassPayloadIsData(null), false);
});

// ── The fan-out ──────────────────────────────────────────────────────────────

test('a refusal moves to the next mirror instead of ending the fan-out', async () => {
  // The exact shape measured against the live mirrors.
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: { status: 406, contentType: 'text/html', body: '<!DOCTYPE HTML><title>406</title>' },
    [ENDPOINTS[1]]: DATA,
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.status, 200);
  assert.equal(payload.endpoint, ENDPOINTS[1]);
  assert.deepEqual(tried, ENDPOINTS.slice(0, 2), 'the healthy mirror must be reached, and no further');
});

test('every mirror is asked with a User-Agent that identifies the application', async () => {
  // The OSM API usage policy asks for a "Valid User-Agent identifying
  // application and version". Every outbound request must carry it, not just
  // the first: a mirror further down the list refusing an unidentified client
  // is exactly the case the fan-out exists to survive.
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, agent: options?.headers?.['User-Agent'] });
    // Refuse everywhere, so the loop is forced through the whole list.
    return { status: 503, headers: { get: () => 'text/html' } };
  };
  await fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    fetchImpl,
    readBody: async () => 'upstream down',
    simplify: (body) => body,
  });

  assert.deepEqual(
    seen.map((request) => request.url),
    ENDPOINTS,
    'the fan-out must reach every mirror',
  );
  for (const request of seen) {
    const agent = String(request.agent || '');
    assert.match(
      agent,
      /^gods-eye-view\/\d/,
      `${request.url} must name the application and its version`,
    );
    assert.ok(
      !/proxy\/1\.0$/.test(agent),
      `${request.url} must not fall back to the unidentified label`,
    );
    assert.match(
      agent,
      /github\.com\/bilawalsidhu\/gods-eye-view/,
      `${request.url} must carry a route back to the project`,
    );
  }
});

test('a mirror that refuses the old label serves the same query under the identifying one', async () => {
  // Recorded from the canonical instance on 2026-09-14: the unidentified label
  // is answered with a 406 Not Acceptable HTML page before the query is read,
  // and the identifying one is served. This stub replays that shape so the
  // behaviour the header change buys is pinned without a live mirror.
  const REFUSED = 'gods-eye-view-overpass-proxy/1.0';
  const answer = (agent) =>
    String(agent || '').startsWith(REFUSED)
      ? {
          status: 406,
          body: '<!DOCTYPE HTML><title>406 Not Acceptable</title>',
          contentType: 'text/html',
        }
      : { status: 200, body: DATA.body, contentType: 'application/json' };

  let last = null;
  const run = (agentOverride) =>
    fetchOverpassPayload('data=x', 1e6, {
      endpoints: [ENDPOINTS[0]],
      fetchImpl: async (url, options) => {
        last = answer(agentOverride ?? options?.headers?.['User-Agent']);
        return { status: last.status, headers: { get: () => last.contentType } };
      },
      readBody: async () => last.body,
      simplify: (body) => body,
    });

  const refused = await run(REFUSED);
  assert.equal(refused.status, 406, 'the old label is refused by the mirror');
  assert.equal(
    overpassPayloadIsData(refused),
    false,
    'a refusal is never treated as data',
  );

  const served = await run(undefined);
  assert.equal(served.status, 200, 'the header the proxy now sends is served');
  assert.equal(overpassPayloadIsData(served), true);
  assert.equal(served.body, DATA.body);
});

test('the first mirror to answer wins, and the rest are left alone', async () => {
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: DATA, [ENDPOINTS[1]]: DATA, [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[0]);
  assert.deepEqual(tried, [ENDPOINTS[0]]);
});

test('a refusal every mirror agrees on is reported, not swallowed', async () => {
  // A genuinely bad query must still say what upstream said — but only after
  // every mirror has had its chance to answer it.
  const refusal = { status: 400, body: 'line 1: parse error' };
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: refusal, [ENDPOINTS[1]]: refusal, [ENDPOINTS[2]]: refusal,
  });

  assert.equal(payload.status, 400);
  assert.equal(payload.endpoint, ENDPOINTS[0], 'the FIRST refusal is the one reported');
  assert.deepEqual(tried, ENDPOINTS);
  assert.equal(overpassPayloadIsData(payload), false, 'so it is neither cached nor served as data');
});

test('a mirror that throws is no different from one that refuses', async () => {
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: { status: 503, body: 'busy' },
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[2]);
  assert.deepEqual(tried, ENDPOINTS);
});

test('when every mirror is unreachable the caller gets a throw, not a payload', async () => {
  const { error, payload } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: new Error('ETIMEDOUT'),
    [ENDPOINTS[2]]: new Error('ENOTFOUND'),
  });

  assert.equal(payload, undefined);
  assert.match(error.message, /ENOTFOUND/);
});

test('production reader rotates past oversized, runtime-error and rate-limited bodies', async () => {
  for (const [status, body] of [
    [200, 'x'.repeat(200)], [200, '{"remark":"runtime error: timed out","elements":[]}'],
    [200, 'rate_limited'], [429, 'busy'], [403, 'forbidden'],
  ]) {
    const tried = [];
    const payload = await fetchOverpassPayload('data=x', 100, {
      endpoints: ENDPOINTS,
      fetchImpl: async (url) => {
        tried.push(url);
        return new Response(tried.length === 1 ? body : DATA.body, {
          status: tried.length === 1 ? status : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(payload.body, DATA.body);
    assert.deepEqual(tried, ENDPOINTS.slice(0, 2));
  }
});

function proxyHandler() {
  const plugin = createViteConfig({ mode: 'test' }).plugins.find(p => p.name === 'overpass-proxy');
  const routes = new Map();
  plugin.configureServer({ middlewares: { use: (route, handler) => routes.set(route, handler) } });
  return routes.get('/api/overpass');
}

function invoke(handler, body) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('coalesced outage callers both receive last-good data, never a cached refusal', async (t) => {
  const handler = proxyHandler();
  for (const status of [406, 503, 429]) {
    const query = `[out:json][timeout:12];node(around:10,30.27,-97.74)["name"="${randomUUID()}"];out;`;
    const body = `data=${encodeURIComponent(query)}`;
    const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
    const file = path.join(directory, `${createHash('sha1').update(body).digest('hex')}.json`);
    await mkdir(directory, { recursive: true });
    const stale = { ...DATA, cachedAt: Date.now() - 40 * 86400000 };
    await writeFile(file, JSON.stringify(stale));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let fetches = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      fetches++;
      entered.resolve();
      await release.promise;
      return new Response('upstream unavailable', { status });
    });
    try {
      const first = invoke(handler, body);
      await entered.promise;
      const second = invoke(handler, body);
      // The second request consumes its in-memory stream and joins the pending
      // promise before releasing upstream. No network or elapsed-time sleep.
      await new Promise(resolve => setImmediate(resolve));
      release.resolve();
      for (const response of await Promise.all([first, second])) {
        assert.equal(response.status, 200, `${status}: both callers use last-good data`);
        assert.equal(response.body, DATA.body);
        assert.equal(response.headers['X-Overpass-Cache'], 'STALE');
      }
      assert.equal(fetches, 4, 'one shared, bounded mirror sequence');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stale);
    } finally {
      release.resolve();
      mock.mock.restore();
      await unlink(file);
    }
  }
});

// ─── Fan-out budget ────────────────────────────────────────────────────────
//
// Every mirror used to get the full per-mirror timeout, so a chain of sick
// mirrors could hold an interactive layer for 88 s on an empty map. The query
// already declares how long the work is worth; that is the budget for the
// whole search, not the allowance for each attempt.

test('a spent budget stops the fan-out instead of asking the next mirror', async () => {
  const tried = [];
  let clock = 0;
  const payload = await fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    now: () => clock,
    fetchImpl: async (url) => { tried.push(url); clock += OVERPASS_TIMEOUT_MS; return { status: 503, headers: { get: () => 'text/html' } }; },
    readBody: async () => 'upstream down',
    simplify: (body) => body,
    budgetMs: OVERPASS_TIMEOUT_MS + 1000,
  });
  assert.deepEqual(tried, [ENDPOINTS[0]], 'the second mirror must not be asked once the budget cannot buy an attempt');
  assert.equal(payload.status, 503, 'the refusal already collected is still what gets reported');
});

test('the first mirror is always asked, however small the budget', async () => {
  const tried = [];
  const payload = await fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    now: () => 0,
    fetchImpl: async (url) => { tried.push(url); return { status: 200, headers: { get: () => 'application/json' } }; },
    readBody: async () => '{"elements":[]}',
    simplify: (body) => body,
    budgetMs: 1,
  });
  assert.deepEqual(tried, [ENDPOINTS[0]]);
  assert.equal(payload.status, 200);
});

test('a budget that is never spent still reaches every mirror', async () => {
  const tried = [];
  const payload = await fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    now: () => 0, // a frozen clock spends nothing
    fetchImpl: async (url) => { tried.push(url); return { status: 503, headers: { get: () => 'text/html' } }; },
    readBody: async () => 'upstream down',
    simplify: (body) => body,
    budgetMs: OVERPASS_TIMEOUT_MS,
  });
  assert.deepEqual(tried, ENDPOINTS, 'healthy timing must not shorten the fan-out');
  assert.equal(payload.status, 503);
});

test('the budget tracks what the query asked for and never exceeds the old worst case', () => {
  const worstCase = OVERPASS_UPSTREAMS.length * OVERPASS_TIMEOUT_MS;
  for (const seconds of [1, 12, 20, 30, 300]) {
    const budget = overpassBudgetMs(seconds);
    assert.ok(budget <= worstCase, `[timeout:${seconds}] must not buy more patience than the ${worstCase} ms it used to get`);
    assert.ok(budget >= OVERPASS_MIN_ATTEMPT_MS, `[timeout:${seconds}] must still buy one real attempt`);
  }
  assert.ok(overpassBudgetMs(12) < overpassBudgetMs(30), 'a query asking for less work must wait less');
  assert.equal(overpassBudgetMs(null), overpassBudgetMs(30), 'a query that declares no timeout gets the clamp ceiling, not unlimited patience');
});

test('the sanitizer reports the clamped timeout the budget is derived from', () => {
  const ask = (seconds) => sanitizeOverpassBody('data=' + encodeURIComponent(`[out:json][timeout:${seconds}];(way["highway"~"^motorway$"](51.4,-0.2,51.6,0.0););out geom qt;`));
  assert.equal(ask(12).qlTimeoutSec, 12, 'the declared timeout is reported as declared');
  assert.equal(ask(900).qlTimeoutSec, 30, 'an over-long ask is reported at the clamp, not as asked');
});
