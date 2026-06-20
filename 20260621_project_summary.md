# 2026-06-21 Web UI 付款月份統計修正

## 問題

記帳管理後台的「本月已付／應付」、「次月預計」及遠期統計，混用了消費月份、帳單月份與實際付款月份，造成：

* `billing_month` 為本月、`settlement_month` 為次月的信用卡消費，被誤列為本月已付／應付。
* `settlement_month` 為更後月份的信用卡消費，被誤列為次月預計。
* 未來月份的預定支出未納入遠期統計。
* 統計卡片、付款 badge 與點擊卡片後的明細使用不同判斷條件。

## 根因

原統計邏輯先以 `parseMonthKey()` 篩選消費月份，再以 `billing_month` 判斷付款月份，導致消費月份與付款月份互相混用。

## 修正內容

* 消費月份統計繼續使用 `parseMonthKey()`。
* 新增 `getPayableMonth()`，集中判斷實際付款月份。
* 信用卡以 `settlement_month` 為主要付款月份，舊資料才 fallback 至 `billing_month`。
* 新增 `isExcluded()`，排除 `deleted=true` 及取消狀態。
* 新增 `isDeferredPayment()`，限制次月及遠期統計只納入信用卡、預定、scheduled、investment 等遞延付款項目。
* 本月已付／應付、次月預計、遠期統計、付款 badge 及點擊後明細，共用相同付款月份邏輯。
* 現金與即時支付只計入實際消費月份，不顯示次月付或遠期 badge。

## 正式驗收結果

選擇 2026 年 6 月進行驗收：

* 富邦 Costco 與中信 Uniopen 正確歸入次月預計。
* 富邦 J 卡 WorldGYM 正確歸入遠期。
* 9 月預定支出正確納入更遠期筆數。
* 現金仍計入本月已付／應付，且不顯示付款 badge。
* 次月預計明細不包含現金。
* 本月消費筆數仍依 `spending_month／date` 計算。
* 正式 GitHub Pages 驗收通過。

