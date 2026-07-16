'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loader = require('../expense-data-loader.js');

const BASE_URL = 'https://line-expense-bot-docker.onrender.com/api/expenses?per_page=500';

function makeRecords(ids) {
  return ids.map((id) => ({
    record_id: id,
    date: '2026-07-01',
    amount: 100,
    category: '其他',
    merchant: 'm-' + id
  }));
}

function page(pageNumber, perPage, total, records) {
  return {
    records: records,
    pagination: {
      page: pageNumber,
      per_page: perPage,
      total: total,
      total_pages: Math.max(1, Math.ceil(total / perPage))
    }
  };
}

/**
 * Build a mock fetchImpl driven by a queue of response specs.
 * Each spec is one of:
 *   { body: <object> }                 -> HTTP 200, resolves body as JSON
 *   { status: <number> }               -> non-2xx HTTP response
 *   { jsonError: true }                -> HTTP 200 but response.json() rejects
 *   { networkError: true }             -> fetchImpl itself rejects
 * Records every call's URL for assertions.
 */
function makeFetch(specs) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const spec = specs[calls.length - 1];
    if (!spec) {
      throw new Error('makeFetch: no spec queued for call #' + calls.length + ' (url=' + url + ')');
    }
    if (spec.networkError) {
      throw new Error('simulated network failure');
    }
    const status = spec.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status: status,
      json: async () => {
        if (spec.jsonError) {
          throw new SyntaxError('simulated invalid JSON');
        }
        return spec.body;
      }
    };
  };
  fn.calls = calls;
  return fn;
}

// ── 1. page 1 already complete: no additional requests ──────────────────────
test('1. page 1 already complete: no additional requests are made', async () => {
  const fetchImpl = makeFetch([{ body: page(1, 500, 3, makeRecords(['a', 'b', 'c'])) }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 3);
  assert.equal(result.requestsMade, 1);
  assert.equal(fetchImpl.calls.length, 1);
});

// ── 2. records.length < total: fetches subsequent pages ─────────────────────
test('2. page 1 incomplete: fetches subsequent pages until total is reached', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 5, makeRecords(['a', 'b'])) },
    { body: page(2, 2, 5, makeRecords(['c', 'd'])) },
    { body: page(3, 2, 5, makeRecords(['e'])) }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records.map((r) => r.record_id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(result.requestsMade, 3);
});

// ── 3. query string preserved, page rewritten, never duplicated ─────────────
test('3a. buildPageUrl preserves existing query string and rewrites page', () => {
  const result = loader.buildPageUrl('https://api.example.com/api/expenses?per_page=500&month=2026-07', 3);
  assert.equal(result.ok, true);
  const parsed = new URL(result.url);
  assert.equal(parsed.searchParams.get('per_page'), '500');
  assert.equal(parsed.searchParams.get('month'), '2026-07');
  assert.equal(parsed.searchParams.get('page'), '3');
  assert.equal(parsed.searchParams.getAll('page').length, 1);
});

test('3b. buildPageUrl overwrites an existing page param instead of duplicating it', () => {
  const result = loader.buildPageUrl('https://api.example.com/api/expenses?page=1&per_page=500', 4);
  assert.equal(result.ok, true);
  const parsed = new URL(result.url);
  assert.equal(parsed.searchParams.getAll('page').length, 1);
  assert.equal(parsed.searchParams.get('page'), '4');
});

// ── 3c. relative URL contract: explicit urlBase resolves correctly ─────────
test('3c. buildPageUrl resolves a relative baseUrl against an explicit resolveBase', () => {
  const result = loader.buildPageUrl('/api/expenses?per_page=500', 2, 'https://example.com/app/index.html');
  assert.equal(result.ok, true);
  const parsed = new URL(result.url);
  assert.equal(parsed.origin, 'https://example.com');
  assert.equal(parsed.pathname, '/api/expenses');
  assert.equal(parsed.searchParams.get('per_page'), '500');
  assert.equal(parsed.searchParams.get('page'), '2');
});

// ── 3d. malformed/unresolvable URL fails closed instead of throwing ────────
test('3d. buildPageUrl fails closed (does not throw) on a relative URL with no base available', () => {
  assert.doesNotThrow(() => {
    const result = loader.buildPageUrl('/api/expenses?per_page=500', 1);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'URL_BUILD_FAILED');
  });
});

test('3e. buildPageUrl fails closed on a structurally malformed URL', () => {
  assert.doesNotThrow(() => {
    const result = loader.buildPageUrl('http://', 1);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'URL_BUILD_FAILED');
  });
});

// ── 4. multi-page success: merged length equals page-1 total ────────────────
test('4. multi-page success: merged records length equals pagination.total', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 6, makeRecords(['a', 'b'])) },
    { body: page(2, 2, 6, makeRecords(['c', 'd'])) },
    { body: page(3, 2, 6, makeRecords(['e', 'f'])) }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 6);
  assert.equal(result.records.length, result.pagination.total);
});

// ── 5. response body is not an object (e.g. a JSON array) ──────────────────
test('5. API response is not an object: fail closed', async () => {
  const fetchImpl = makeFetch([{ body: [] }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.errorCode, 'INVALID_RESPONSE_SHAPE');
  assert.deepEqual(result.records, []);
});

// ── 6. records is not an array ──────────────────────────────────────────────
test('6. records field is not an array: fail closed', async () => {
  const fetchImpl = makeFetch([{ body: { records: 'not-an-array', pagination: { page: 1, per_page: 500, total: 0, total_pages: 1 } } }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INVALID_RECORDS_SHAPE');
});

// ── 7. pagination is missing ────────────────────────────────────────────────
test('7. pagination field missing: fail closed', async () => {
  const fetchImpl = makeFetch([{ body: { records: [] } }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INVALID_PAGINATION_SHAPE');
});

// ── 8. pagination metadata has wrong types ──────────────────────────────────
test('8. pagination metadata has wrong types: fail closed', async () => {
  const fetchImpl = makeFetch([
    { body: { records: [], pagination: { page: 1, per_page: 500, total: '0', total_pages: 1 } } }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PAGINATION_METADATA_INVALID');
});

// ── 9. pagination metadata is internally contradictory ──────────────────────
test('9. pagination metadata is contradictory (total_pages inconsistent with total/per_page): fail closed', async () => {
  const fetchImpl = makeFetch([
    { body: { records: makeRecords(['a', 'b']), pagination: { page: 1, per_page: 5, total: 10, total_pages: 1 } } }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PAGINATION_METADATA_CONTRADICTORY');
});

// ── 10. HTTP non-success status ─────────────────────────────────────────────
test('10. HTTP non-success status: fail closed', async () => {
  const fetchImpl = makeFetch([{ status: 500 }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'HTTP_ERROR');
});

// ── 11. JSON parse failure ──────────────────────────────────────────────────
test('11. JSON parse failure: fail closed', async () => {
  const fetchImpl = makeFetch([{ jsonError: true }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INVALID_JSON');
});

// ── 12. a later page fails ──────────────────────────────────────────────────
test('12. a subsequent page request fails: fail closed', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 4, makeRecords(['a', 'b'])) },
    { networkError: true }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NETWORK_ERROR');
  assert.equal(result.requestsMade, 2);
});

// ── 13. subsequent page's pagination.page doesn't match requested page ──────
test('13. subsequent page pagination.page does not match the requested page number: fail closed', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 4, makeRecords(['a', 'b'])) },
    { body: page(3, 2, 4, makeRecords(['c', 'd'])) } // server echoes page:3 for a page=2 request
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PAGE_NUMBER_MISMATCH');
});

// ── 14. subsequent page's core pagination snapshot differs from page 1 ──────
test('14. subsequent page pagination snapshot differs from page 1: fail closed', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 4, makeRecords(['a', 'b'])) },
    { body: page(2, 2, 5, makeRecords(['c', 'd'])) } // total changed mid-pagination
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PAGINATION_SNAPSHOT_MISMATCH');
});

// ── 15. request cap enforcement ─────────────────────────────────────────────
test('15. request cap: fail closed immediately when total_pages exceeds maxPageRequests', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 10, 1000, makeRecords(Array.from({ length: 10 }, (_, i) => 'r' + i))) }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl, maxPageRequests: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'REQUEST_CAP_EXCEEDED');
  // Must not have attempted any request beyond page 1 once the cap is known to be exceeded.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.requestsMade, 1);
});

// ── 16. failed result never exposes already-fetched partial records ────────
test('16. failure result exposes empty records, never already-fetched partial data', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 4, makeRecords(['a', 'b'])) }, // 2 good records fetched here
    { status: 502 } // then page 2 fails
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.ok(Array.isArray(result.records));
  assert.equal(result.records.length, 0);
});

// ── 17. duplicate record_id across pages ────────────────────────────────────
test('17. duplicate record_id across pages: fail closed', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 4, makeRecords(['a', 'b'])) },
    { body: page(2, 2, 4, makeRecords(['b', 'c'])) } // 'b' repeated
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DUPLICATE_RECORD_ID');
  assert.deepEqual(result.records, []);
});

// ── 18. total === 0 with empty records succeeds ─────────────────────────────
test('18. total is 0 and records is empty: succeeds with an empty complete result', async () => {
  const fetchImpl = makeFetch([{ body: page(1, 500, 0, []) }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records, []);
  assert.equal(result.requestsMade, 1);
});

// ── 19. page 1 claims a single page but records.length !== total ───────────
test('19. page 1 declares total_pages=1 (complete) but records.length !== total: fail closed', async () => {
  const fetchImpl = makeFetch([
    { body: { records: makeRecords(['a', 'b']), pagination: { page: 1, per_page: 500, total: 3, total_pages: 1 } } }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MERGED_LENGTH_MISMATCH');
});

// ── 20. all pages fetched per total_pages but merged count still mismatches ─
test('20. merged record count mismatches total after fetching every declared page: fail closed', async () => {
  // total=5, per_page=2 => total_pages=3 (consistent), but page 3 unexpectedly
  // returns 0 records instead of 1 (e.g. a row was deleted mid-pagination).
  const fetchImpl = makeFetch([
    { body: page(1, 2, 5, makeRecords(['a', 'b'])) },
    { body: page(2, 2, 5, makeRecords(['c', 'd'])) },
    { body: page(3, 2, 5, []) }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MERGED_LENGTH_MISMATCH');
  assert.equal(result.requestsMade, 3);
});

// ── 21. fetchImpl throws synchronously (not a rejected promise) ────────────
test('21. fetchImpl throws synchronously: fail closed, no throw escapes fetchAllExpensePages', async () => {
  // Deliberately not an async function: this throws before any Promise is
  // even created, exercising the "loader synchronous throw" contract from
  // the Codex review (distinct from a rejected Promise / async error).
  function syncThrowingFetch() {
    throw new Error('boom: synchronous throw from fetchImpl');
  }

  let result;
  await assert.doesNotReject(async () => {
    result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl: syncThrowingFetch });
  });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.equal(result.errorCode, 'NETWORK_ERROR');
});

// ── 22. malformed/unresolvable URL: fail closed, fetch never called ────────
test('22. malformed URL (relative, no base available): fail closed and fetch is never invoked', async () => {
  const fetchImpl = makeFetch([]);
  const result = await loader.fetchAllExpensePages({ url: '/api/expenses?per_page=500', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.equal(result.errorCode, 'URL_BUILD_FAILED');
  assert.equal(result.requestsMade, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

// ── 23. relative URL contract via options.urlBase: builds and fetches correctly ─
test('23. relative url + explicit urlBase: builds correct absolute request URL, preserves per_page', async () => {
  const fetchImpl = makeFetch([{ body: page(1, 500, 2, makeRecords(['a', 'b'])) }]);
  const result = await loader.fetchAllExpensePages({
    url: '/api/expenses?per_page=500',
    urlBase: 'https://example.com/app/index.html',
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(fetchImpl.calls.length, 1);
  const parsed = new URL(fetchImpl.calls[0]);
  assert.equal(parsed.origin, 'https://example.com');
  assert.equal(parsed.pathname, '/api/expenses');
  assert.equal(parsed.searchParams.get('per_page'), '500');
  assert.equal(parsed.searchParams.get('page'), '1');
});

// ── 24. absolute URL production behavior is unchanged ──────────────────────
test('24. absolute URL (production shape): behaves exactly as before, urlBase ignored/unnecessary', async () => {
  const fetchImpl = makeFetch([{ body: page(1, 500, 1, makeRecords(['a'])) }]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls[0], BASE_URL + '&page=1');
});

// ── 25. multi-page success asserts the exact request URL sequence ──────────
test('25. multi-page success: asserts actual request URLs for page=1,2,3 (not just call count)', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 5, makeRecords(['a', 'b'])) },
    { body: page(2, 2, 5, makeRecords(['c', 'd'])) },
    { body: page(3, 2, 5, makeRecords(['e'])) }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(fetchImpl.calls, [
    BASE_URL + '&page=1',
    BASE_URL + '&page=2',
    BASE_URL + '&page=3'
  ]);
});

// ── 26. request cap boundary: total_pages === maxPageRequests succeeds ─────
test('26. request cap boundary: total_pages equal to maxPageRequests is allowed to proceed', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 1, 3, makeRecords(['a'])) },
    { body: page(2, 1, 3, makeRecords(['b'])) },
    { body: page(3, 1, 3, makeRecords(['c'])) }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl, maxPageRequests: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.requestsMade, 3);
  assert.deepEqual(result.records.map((r) => r.record_id), ['a', 'b', 'c']);
});

// ── 27. record_id type normalization: 1 (number) and "1" (string) are the same ID ─
test('27. duplicate detection treats numeric 1 and string "1" as the same record_id', async () => {
  const fetchImpl = makeFetch([
    { body: page(1, 2, 4, [
      { record_id: 1, date: '2026-07-01', amount: 100, category: '其他', merchant: 'm-1' },
      { record_id: 'x', date: '2026-07-01', amount: 100, category: '其他', merchant: 'm-x' }
    ]) },
    { body: page(2, 2, 4, [
      { record_id: '1', date: '2026-07-02', amount: 200, category: '其他', merchant: 'm-1b' },
      { record_id: 'y', date: '2026-07-02', amount: 200, category: '其他', merchant: 'm-y' }
    ]) }
  ]);
  const result = await loader.fetchAllExpensePages({ url: BASE_URL, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DUPLICATE_RECORD_ID');
  assert.deepEqual(result.records, []);
});
