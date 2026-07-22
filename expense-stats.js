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

  // ── Legacy editable 判斷（P2，Codex 第八輪 remediation）──
  // 後端 get_all_expenses()/_web_row_to_dict() 對每一筆記錄都會回傳
  // editable（bool）：false 代表這筆資料的 record_id 是位置性的
  // LEGACY-ROW-N 佔位識別碼（尚未經過 backfill_expense_record_ids()
  // 升級），送出 PUT/DELETE 一定會被後端拒絕（UnstableRecordIdentityError）
  // ——前端必須在使用者按下編輯／刪除「之前」就先隱藏或停用這兩個按鈕，
  // 不能讓使用者填完表單送出後才收到錯誤。欄位缺失（例如舊版快取資料，
  // 理論上不應發生，因為後端一律回傳這個欄位）時保守視為不可編輯，而不
  // 是預設可編輯——寧可多一次「需升級」提示，也不要讓使用者送出後才失敗。
  var LEGACY_UPGRADE_MESSAGE = '舊資料，需完成識別碼升級後才能修改';

  function isRecordEditable(r) {
    return !!r && r.editable === true;
  }

  // ── Transfer 顯示標籤（P2，Codex 第八輪 remediation）──
  // transaction_type=transfer 的記錄本來就不會有 card_name（validate_
  // transaction_record() 的 UNIVERSAL 規則禁止 transfer 帶 card_name），
  // 舊版 renderTable() 的 cardOrPay 邏輯在 card_name 為空時一律 fallback
  // 成「刷卡」，把每一筆轉帳／儲值／信用卡繳款都誤標成刷卡消費。
  //
  // 目前後端實際資料模型（見 LINE_INPUT_RULES.md 第 10 節／database.py
  // EXPENSE_COLUMNS）尚未有獨立的 transfer_subtype 欄位——這裡優先讀取
  // r.transfer_subtype（若未來後端新增則自動生效，不需要再改前端），
  // 沒有時才退回用 to_account 內容做保守的字串比對，分不出來就一律顯示
  // 通用的「轉帳」，絕不落回「刷卡」。
  var KNOWN_TRANSFER_SUBTYPES = { transfer: '轉帳', topup: '儲值', credit_card_payment: '信用卡繳款' };

  function transferDisplayLabel(r) {
    if (r.transfer_subtype) {
      return KNOWN_TRANSFER_SUBTYPES[r.transfer_subtype] || r.transfer_subtype;
    }
    var to = (r.to_account || '').trim();
    if (/信用卡|卡$/.test(to)) return '信用卡繳款';
    if (/悠遊付|Pay|錢包|付$/.test(to)) return '儲值';
    return '轉帳';
  }

  function paymentDisplayLabel(r) {
    if (!r) return '';
    if (r.transaction_type === 'transfer') return transferDisplayLabel(r);
    if (r.card_name) return r.card_name;
    if (r.payment_type === 'cash') return '現金';
    if (r.payment_type === 'scheduled') return '定期';
    return '刷卡';
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── 單筆交易列的 HTML（P2，Codex 第八輪 remediation）──
  // renderTable() 過去把整段 <tr> 樣板直接寫在 index.html 的 DOM 程式碼裡，
  // 無法獨立測試（只能靠手動點網頁）。移到這裡成為純函式，index.html 的
  // renderTable() 現在直接呼叫這個函式組出每一列——測試呼叫的就是正式程式
  // 碼本身，不是另一份重寫的邏輯。`nextMonthValue` 由呼叫端算好傳入（避免
  // 這裡直接碰 DOM），對應目前篩選器選到的月份，用來判斷次月付／遠期 badge。
  function buildExpenseRowHtml(r, nextMonthValue) {
    var bc = 'b-' + (r.category || '其他');
    var cardOrPay = paymentDisplayLabel(r);
    var billingBadge = '';
    if (isDeferredPayment(r)) {
      var pm = getPayableMonth(r);
      if (pm === nextMonthValue) {
        billingBadge = '<span style="margin-left:4px;font-size:10px;padding:1px 5px;border-radius:10px;background:#faeeda;color:#854f0b">次月付</span>';
      } else if (pm && pm > nextMonthValue) {
        billingBadge = '<span style="margin-left:4px;font-size:10px;padding:1px 5px;border-radius:10px;background:#eeedfe;color:#534ab7">遠期</span>';
      }
    }
    var actionsHtml;
    if (isRecordEditable(r)) {
      actionsHtml =
        '<button class="icon-btn" onclick="openEdit(\'' + r.record_id + '\')" title="編輯"><i class="ti ti-edit"></i></button>' +
        '<button class="icon-btn danger" onclick="confirmDel(\'' + r.record_id + '\')" title="刪除"><i class="ti ti-trash"></i></button>';
    } else {
      actionsHtml = '<span class="legacy-upgrade-note" title="' + escHtml(LEGACY_UPGRADE_MESSAGE) + '" style="color:#999;font-size:11px">' + escHtml(LEGACY_UPGRADE_MESSAGE) + '</span>';
    }
    return '<tr>' +
      '<td class="col-date" style="color:#666">' + ((r.date || '').slice(5) || '') + '</td>' +
      '<td class="col-cat"><span class="badge ' + bc + '">' + escHtml(r.category || '') + '</span></td>' +
      '<td class="col-merchant">' + escHtml(r.merchant || r.item || '—') + '</td>' +
      '<td class="col-item" style="color:#666">' + escHtml(r.item || '—') + '</td>' +
      '<td class="col-card" style="color:#666;font-size:12px">' + escHtml(cardOrPay) + billingBadge + '</td>' +
      '<td class="col-amt"><span class="amount">$' + Math.round(r.amount || 0).toLocaleString() + '</span></td>' +
      '<td class="col-act"><div class="row-actions">' + actionsHtml + '</div></td>' +
      '</tr>';
  }

  return {
    isExcluded: isExcluded,
    isDeferredPayment: isDeferredPayment,
    isExpenseEligible: isExpenseEligible,
    parseMonthKey: parseMonthKey,
    getPayableMonth: getPayableMonth,
    nextMonth: nextMonth,
    stableStringify: stableStringify,
    decideIdempotencyKey: decideIdempotencyKey,
    isRecordEditable: isRecordEditable,
    transferDisplayLabel: transferDisplayLabel,
    paymentDisplayLabel: paymentDisplayLabel,
    LEGACY_UPGRADE_MESSAGE: LEGACY_UPGRADE_MESSAGE,
    buildExpenseRowHtml: buildExpenseRowHtml
  };
});
