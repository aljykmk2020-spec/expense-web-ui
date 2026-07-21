/**
 * expense-stats.js
 *
 * DOM-free expense-eligibility / statistics-classification / idempotency-key
 * lifecycle helpers for the expense Web UI. Loaded both as a plain browser
 * <script> (exposes window.ExpenseStats) and via Node's CommonJS require()
 * in tests (module.exports), so production code and tests always run the
 * exact same logic — same pattern as expense-data-loader.js.
 *
 * This module never touches document/window/DOM/fetch and never mutates
 * caller state; every function is a pure function of its arguments.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.ExpenseStats = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 排除判斷（deleted + cancelled）──
  function isExcluded(r) {
    if (!r) return true;
    if ((r.deleted + '').trim().toLowerCase() === 'true') return true;
    var st = (r.status + '').trim().toLowerCase();
    return st === 'cancelled' || st === 'canceled' || st === '已取消';
  }

  // ── 遞延付款類型判斷（次月預計／遠期／badge 限用此類）──
  // cash／即時支付屬於當月消費當月付，不應出現在次月或遠期統計。
  function isDeferredPayment(r) {
    if (!r) return false;
    var pt = (r.payment_type || '').trim();
    var cat = (r.category || '').trim();
    return pt === 'credit_card' || pt === 'scheduled' || pt === 'investment' || cat === '預定';
  }

  // ── 支出統計資格判斷（Codex 第七輪 P1-5：唯一共用 predicate，所有支出統計／
  // 圖表都必須使用這個函式，不得自行各寫各的排除邏輯）──
  // transaction_type=transfer（帳戶間資金移動）與 income 都不是支出，一律排
  // 除；任何非 "expense" 的值（含空白／未知，代表後端回報的新 schema 資料
  // 異常列）也一律排除 —— 前端不得自行把 blank 當成 legacy expense；合法
  // legacy 資料已由後端 API canonicalize 成明確的 "expense" 字串。
  // deleted／cancelled 一併排除（見 isExcluded()）。
  // transfer 仍可正常顯示在交易清單中，只是不得進入這裡涵蓋的任何支出統計。
  function isExpenseEligible(r) {
    return !!r && !isExcluded(r) && r.transaction_type === 'expense';
  }

  function parseMonthKey(r) {
    if (!r) return '';
    // 預定類：優先用 settlement_month，沒有則用 billing_month（付款月優先）
    if (r.category === '預定') {
      if (r.settlement_month && /^\d{4}-\d{2}$/.test(r.settlement_month)) return r.settlement_month;
      if (r.billing_month && /^\d{4}-\d{2}$/.test(r.billing_month)) return r.billing_month;
    }
    if (r.spending_month && /^\d{4}-\d{2}$/.test(r.spending_month)) return r.spending_month;
    var d = r.date || '';
    if (/^\d{4}-\d{2}/.test(d)) return d.slice(0, 7);
    if (/^\d{4}\/\d{2}/.test(d)) return d.slice(0, 7).replace('/', '-');
    return '';
  }

  // ── 付款月份判斷（統計卡片、badge、點擊明細共用）──
  // 消費月份（清單、趨勢圖、圓餅圖、本月消費筆數）仍使用 parseMonthKey，兩者刻意分開。
  function getPayableMonth(r) {
    if (!r) return '';
    var pt = (r.payment_type || 'cash').trim();
    var sm = (r.settlement_month || '').trim();
    var bm = (r.billing_month || '').trim();
    var spm = (r.spending_month || '').trim();
    var d = (r.date || '');
    function fromDate() {
      if (/^\d{4}-\d{2}/.test(d)) return d.slice(0, 7);
      if (/^\d{4}\/\d{2}/.test(d)) return d.slice(0, 7).replace('/', '-');
      return '';
    }
    // scheduled（含 category=預定）：settlement_month → billing_month → spending_month → date
    if (pt === 'scheduled' || r.category === '預定') {
      if (/^\d{4}-\d{2}$/.test(sm)) return sm;
      if (/^\d{4}-\d{2}$/.test(bm)) return bm;
      if (/^\d{4}-\d{2}$/.test(spm)) return spm;
      return fromDate();
    }
    // credit_card：優先 settlement_month（實際繳款月），fallback billing_month
    if (pt === 'credit_card') {
      if (/^\d{4}-\d{2}$/.test(sm)) return sm;
      if (/^\d{4}-\d{2}$/.test(bm)) return bm;
      return '';
    }
    // investment：settlement_month → billing_month → spending_month → date
    if (pt === 'investment') {
      if (/^\d{4}-\d{2}$/.test(sm)) return sm;
      if (/^\d{4}-\d{2}$/.test(bm)) return bm;
      if (/^\d{4}-\d{2}$/.test(spm)) return spm;
      return fromDate();
    }
    // cash / 即時支付：spending_month → date
    if (/^\d{4}-\d{2}$/.test(spm)) return spm;
    return fromDate();
  }

  function nextMonth(ym) {
    var parts = ym.split('-').map(Number);
    var y = parts[0], m = parts[1];
    var nd = new Date(y, m, 1); // m 已是 1-based，Date month 是 0-based，所以 m=next
    return nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0');
  }

  // 穩定序列化（key 排序），避免同一內容因物件屬性順序不同被誤判為「payload 已變」。
  function stableStringify(obj) {
    var sortedEntries = Object.keys(obj).sort().map(function (k) { return [k, obj[k]]; });
    return JSON.stringify(sortedEntries);
  }

  /**
   * Codex 第七輪 P1-3：決定這次「新增」送出應該沿用哪個 idempotency key。
   *
   * 純函式版本的 key 生命週期規則，供 saveRecord() 與測試共用：
   * - prevKey 不存在，或 prevPayloadHash 與這次 payload 的 hash 不同（代表
   *   使用者修改了表單內容才又送出）→ 產生新 key。
   * - 否則（同一次未完成送出的 timeout／ambiguous retry，內容完全沒變）→
   *   沿用 prevKey，不重新產生。
   *
   * `randomId` 由呼叫端注入（通常是 crypto.randomUUID），讓這個函式本身
   *保持完全確定性、DOM-free、無副作用，方便測試。
   */
  function decideIdempotencyKey(prevKey, prevPayloadHash, payload, randomId) {
    var payloadHash = stableStringify(payload);
    if (!prevKey || prevPayloadHash !== payloadHash) {
      return { key: randomId(), payloadHash: payloadHash, isNewKey: true };
    }
    return { key: prevKey, payloadHash: payloadHash, isNewKey: false };
  }

  return {
    isExcluded: isExcluded,
    isDeferredPayment: isDeferredPayment,
    isExpenseEligible: isExpenseEligible,
    parseMonthKey: parseMonthKey,
    getPayableMonth: getPayableMonth,
    nextMonth: nextMonth,
    stableStringify: stableStringify,
    decideIdempotencyKey: decideIdempotencyKey
  };
});
