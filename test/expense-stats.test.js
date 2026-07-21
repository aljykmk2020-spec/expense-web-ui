'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../expense-stats.js');

// Codex 第七輪 P1-5 required fixture (section 八):
//   expense 100 / transfer 1000 / income 500 / deleted expense 200 / cancelled expense 300
// Every expense-eligible aggregate over this set must yield count=1, total=100.
function fixtureRecords() {
  return [
    { record_id: 'e1', date: '2026-07-01', amount: 100, category: '餐飲', merchant: 'a', transaction_type: 'expense' },
    { record_id: 't1', date: '2026-07-01', amount: 1000, category: '轉帳', merchant: '', transaction_type: 'transfer' },
    { record_id: 'i1', date: '2026-07-01', amount: 500, category: '收入', merchant: 'b', transaction_type: 'income' },
    { record_id: 'd1', date: '2026-07-01', amount: 200, category: '餐飲', merchant: 'c', transaction_type: 'expense', deleted: 'true' },
    { record_id: 'c1', date: '2026-07-01', amount: 300, category: '餐飲', merchant: 'd', transaction_type: 'expense', status: 'cancelled' }
  ];
}

function expenseAggregate(records) {
  const eligible = records.filter(stats.isExpenseEligible);
  return { count: eligible.length, total: eligible.reduce((s, r) => s + (Number(r.amount) || 0), 0) };
}

test('isExpenseEligible: required fixture (P1-5 section 8) reduces to count=1 total=100', () => {
  const { count, total } = expenseAggregate(fixtureRecords());
  assert.equal(count, 1);
  assert.equal(total, 100);
});

test('isExpenseEligible: transfer-only dataset yields count=0 total=0', () => {
  const records = [
    { amount: 100, transaction_type: 'transfer' },
    { amount: 200, transaction_type: 'transfer' }
  ];
  const { count, total } = expenseAggregate(records);
  assert.equal(count, 0);
  assert.equal(total, 0);
});

test('isExpenseEligible: income-only dataset yields count=0 total=0', () => {
  const records = [
    { amount: 100, transaction_type: 'income' },
    { amount: 200, transaction_type: 'income' }
  ];
  const { count, total } = expenseAggregate(records);
  assert.equal(count, 0);
  assert.equal(total, 0);
});

test('isExpenseEligible: blank/invalid transaction_type is excluded (new-schema data-integrity row)', () => {
  assert.equal(stats.isExpenseEligible({ amount: 100, transaction_type: '' }), false);
  assert.equal(stats.isExpenseEligible({ amount: 100, transaction_type: '   ' }), false);
  assert.equal(stats.isExpenseEligible({ amount: 100 }), false); // missing key entirely
  assert.equal(stats.isExpenseEligible({ amount: 100, transaction_type: 'bogus' }), false);
});

test('isExpenseEligible: front end never treats blank as legacy expense on its own', () => {
  // The backend is responsible for canonicalizing a genuinely legacy row
  // (no transaction_type column at all) to the literal string "expense"
  // before it ever reaches the front end -- the front end must not
  // second-guess a blank value into eligibility itself.
  const legacyAlreadyCanonicalized = { amount: 120, transaction_type: 'expense' };
  const rawBlankFromBrokenApi = { amount: 120, transaction_type: '' };
  assert.equal(stats.isExpenseEligible(legacyAlreadyCanonicalized), true);
  assert.equal(stats.isExpenseEligible(rawBlankFromBrokenApi), false);
});

test('isExpenseEligible: null/undefined record is excluded, not thrown', () => {
  assert.equal(stats.isExpenseEligible(null), false);
  assert.equal(stats.isExpenseEligible(undefined), false);
});

test('isExpenseEligible: deleted=TRUE (any case) is excluded', () => {
  assert.equal(stats.isExpenseEligible({ amount: 100, transaction_type: 'expense', deleted: 'TRUE' }), false);
  assert.equal(stats.isExpenseEligible({ amount: 100, transaction_type: 'expense', deleted: ' true ' }), false);
});

test('isExpenseEligible: cancelled/canceled/已取消 status is excluded', () => {
  for (const st of ['cancelled', 'canceled', '已取消', 'CANCELLED']) {
    assert.equal(stats.isExpenseEligible({ amount: 100, transaction_type: 'expense', status: st }), false, st);
  }
});

// ── Dashboard / chart aggregation coverage (section 8: "不得只修一個圖表") ──

test('dashboard: trend-chart-style monthly sum excludes transfer/income/invalid', () => {
  const records = fixtureRecords();
  const julySum = records
    .filter((r) => stats.isExpenseEligible(r) && stats.parseMonthKey(r) === '2026-07')
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);
  assert.equal(julySum, 100);
});

test('dashboard: category pie-chart aggregation excludes transfer/income/invalid', () => {
  const records = fixtureRecords();
  const catMap = {};
  records
    .filter((r) => stats.isExpenseEligible(r) && stats.parseMonthKey(r) === '2026-07')
    .forEach((r) => { catMap[r.category] = (catMap[r.category] || 0) + (Number(r.amount) || 0); });
  assert.deepEqual(catMap, { '餐飲': 100 });
});

test('dashboard: paid/payable totals (getPayableMonth-based) exclude transfer/income/invalid', () => {
  const records = fixtureRecords().map((r) => ({ ...r, payment_type: 'cash', spending_month: '2026-07' }));
  const paid = records.filter((r) => stats.isExpenseEligible(r) && stats.getPayableMonth(r) === '2026-07');
  const paidTotal = paid.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  assert.equal(paid.length, 1);
  assert.equal(paidTotal, 100);
});

test('dashboard: max-single-expense stat excludes transfer even though it has the largest amount', () => {
  const records = fixtureRecords();
  const eligible = records.filter(stats.isExpenseEligible);
  const maxR = eligible.reduce((m, r) => ((Number(r.amount) || 0) > (Number(m.amount) || 0) ? r : m), {});
  assert.equal(maxR.amount, 100); // NOT the 1000 transfer
});

test('legacy record already canonicalized by the API (transaction_type="expense") is counted normally', () => {
  const records = [
    { amount: 80, category: '餐飲', transaction_type: 'expense', date: '2026-07-05' }
  ];
  const { count, total } = expenseAggregate(records);
  assert.equal(count, 1);
  assert.equal(total, 80);
});

// ── Idempotency key lifecycle (P1-3) ──

test('decideIdempotencyKey: first save generates a new key', () => {
  const result = stats.decideIdempotencyKey(null, null, { amount: 100 }, () => 'uuid-1');
  assert.equal(result.key, 'uuid-1');
  assert.equal(result.isNewKey, true);
});

test('decideIdempotencyKey: retry with identical payload reuses the same key (no new key generated)', () => {
  let calls = 0;
  const randomId = () => { calls += 1; return 'uuid-' + calls; };
  const first = stats.decideIdempotencyKey(null, null, { amount: 100, merchant: 'a' }, randomId);
  const retry = stats.decideIdempotencyKey(first.key, first.payloadHash, { amount: 100, merchant: 'a' }, randomId);
  assert.equal(retry.key, first.key);
  assert.equal(retry.isNewKey, false);
  assert.equal(calls, 1); // randomId only invoked once, for the first attempt
});

test('decideIdempotencyKey: changed payload after a failed attempt generates a NEW key', () => {
  const randomId = (() => { let n = 0; return () => { n += 1; return 'uuid-' + n; }; })();
  const first = stats.decideIdempotencyKey(null, null, { amount: 100 }, randomId);
  const changed = stats.decideIdempotencyKey(first.key, first.payloadHash, { amount: 200 }, randomId);
  assert.notEqual(changed.key, first.key);
  assert.equal(changed.isNewKey, true);
});

test('decideIdempotencyKey: key order in the payload object does not matter (stable hash)', () => {
  const randomId = () => 'uuid-x';
  const a = stats.decideIdempotencyKey(null, null, { amount: 100, merchant: 'm' }, randomId);
  const b = stats.decideIdempotencyKey(a.key, a.payloadHash, { merchant: 'm', amount: 100 }, randomId);
  assert.equal(b.isNewKey, false); // same content, different key order -> still recognized as unchanged
});

test('stableStringify: distinguishes "100" (string) from 100 (number) -- not silently treated as equal', () => {
  assert.notEqual(stats.stableStringify({ amount: '100' }), stats.stableStringify({ amount: 100 }));
});
