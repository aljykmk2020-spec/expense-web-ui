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

// ── P2 (Codex eighth-round remediation): legacy editable ──

test('isRecordEditable: editable=true is editable', () => {
  assert.equal(stats.isRecordEditable({ record_id: 'e1', editable: true }), true);
});

test('isRecordEditable: editable=false is not editable', () => {
  assert.equal(stats.isRecordEditable({ record_id: 'e1', editable: false }), false);
});

test('isRecordEditable: missing editable field is conservatively treated as NOT editable', () => {
  assert.equal(stats.isRecordEditable({ record_id: 'e1' }), false);
});

test('isRecordEditable: null/undefined record is not editable', () => {
  assert.equal(stats.isRecordEditable(null), false);
  assert.equal(stats.isRecordEditable(undefined), false);
});

// ── P2: transfer display (never falls back to 刷卡) ──

test('paymentDisplayLabel: transfer with no card_name never displays 刷卡', () => {
  const label = stats.paymentDisplayLabel({ transaction_type: 'transfer', payment_type: 'transfer', card_name: '', from_account: '台新銀行', to_account: '國泰銀行' });
  assert.notEqual(label, '刷卡');
});

test('paymentDisplayLabel: transfer to a bank account displays 轉帳', () => {
  const label = stats.paymentDisplayLabel({ transaction_type: 'transfer', from_account: '台新銀行', to_account: '國泰銀行' });
  assert.equal(label, '轉帳');
});

test('paymentDisplayLabel: transfer to an e-wallet displays 儲值', () => {
  const label = stats.paymentDisplayLabel({ transaction_type: 'transfer', from_account: '台新銀行', to_account: '悠遊付' });
  assert.equal(label, '儲值');
});

test('paymentDisplayLabel: transfer to a credit card displays 信用卡繳款', () => {
  const label = stats.paymentDisplayLabel({ transaction_type: 'transfer', from_account: '台新銀行', to_account: '玉山信用卡' });
  assert.equal(label, '信用卡繳款');
});

test('paymentDisplayLabel: explicit transfer_subtype is used verbatim over the heuristic', () => {
  const label = stats.paymentDisplayLabel({ transaction_type: 'transfer', transfer_subtype: 'topup', to_account: '任意字串' });
  assert.equal(label, '儲值');
});

test('paymentDisplayLabel: ordinary credit_card expense with card_name displays the card name', () => {
  const label = stats.paymentDisplayLabel({ transaction_type: 'expense', payment_type: 'credit_card', card_name: '玉山Unicard' });
  assert.equal(label, '玉山Unicard');
});

test('paymentDisplayLabel: ordinary cash expense displays 現金', () => {
  const label = stats.paymentDisplayLabel({ transaction_type: 'expense', payment_type: 'cash', card_name: '' });
  assert.equal(label, '現金');
});

// ── P2: buildExpenseRowHtml() -- the ACTUAL renderTable() row-building
// logic, not a reimplementation; index.html's renderTable() calls this
// exact function per record. ──

test('buildExpenseRowHtml: editable record renders edit/delete buttons, not the legacy note', () => {
  const html = stats.buildExpenseRowHtml({ record_id: 'e1', editable: true, date: '2026-07-01', amount: 100, category: '餐飲', merchant: 'lunch', payment_type: 'cash', transaction_type: 'expense' }, '2026-08');
  assert.match(html, /onclick="openEdit\('e1'\)"/);
  assert.match(html, /onclick="confirmDel\('e1'\)"/);
  assert.doesNotMatch(html, /legacy-upgrade-note/);
});

test('buildExpenseRowHtml: non-editable legacy record renders the upgrade note, not action buttons', () => {
  const html = stats.buildExpenseRowHtml({ record_id: 'LEGACY-ROW-2', editable: false, date: '2026-07-01', amount: 100, category: '餐飲', merchant: 'lunch', payment_type: 'cash', transaction_type: 'expense' }, '2026-08');
  assert.match(html, /legacy-upgrade-note/);
  assert.match(html, /舊資料，需完成識別碼升級後才能修改/);
  assert.doesNotMatch(html, /onclick="openEdit/);
  assert.doesNotMatch(html, /onclick="confirmDel/);
});

test('buildExpenseRowHtml: transfer row never renders 刷卡', () => {
  const html = stats.buildExpenseRowHtml({ record_id: 't1', editable: true, date: '2026-07-01', amount: 1000, category: '轉帳', merchant: '', transaction_type: 'transfer', from_account: '台新銀行', to_account: '國泰銀行' }, '2026-08');
  assert.doesNotMatch(html, /刷卡/);
  assert.match(html, /轉帳/);
});

test('buildExpenseRowHtml: merchant/item HTML-escapes untrusted content', () => {
  const html = stats.buildExpenseRowHtml({ record_id: 'e1', editable: true, date: '2026-07-01', amount: 100, category: '餐飲', merchant: '<script>alert(1)</script>', payment_type: 'cash', transaction_type: 'expense' }, '2026-08');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
