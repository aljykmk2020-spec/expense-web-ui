/**
 * expense-data-loader.js
 *
 * DOM-free pagination + data-completeness loader for the expense Web UI.
 * Loaded both as a plain browser <script> (exposes window.ExpenseDataLoader)
 * and via Node's CommonJS require() in tests (module.exports), so production
 * code and tests always run the exact same logic.
 *
 * This module never touches document/window/DOM, never mutates caller state,
 * and never calls application-level functions (applyFilters, alert, etc.).
 * It only fetches, validates, merges, and returns a plain result object.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.ExpenseDataLoader = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Overall request cap (page 1 + all subsequent pages combined).
  // Current known production volume is ~404 active records at per_page=500,
  // i.e. 1 page today. A cap of 20 requests allows up to 20 * 500 = 10,000
  // records (~25x current volume) before refusing to continue, which is a
  // conservative bound that protects the backend (each request re-reads the
  // entire Google Sheet) from runaway/infinite pagination if pagination
  // metadata is ever corrupt or contradictory, while leaving generous
  // headroom for near-term real data growth.
  var MAX_PAGE_REQUESTS = 20;

  var ERROR_CODES = {
    INVALID_INPUT: 'INVALID_INPUT',
    NETWORK_ERROR: 'NETWORK_ERROR',
    HTTP_ERROR: 'HTTP_ERROR',
    INVALID_JSON: 'INVALID_JSON',
    INVALID_RESPONSE_SHAPE: 'INVALID_RESPONSE_SHAPE',
    INVALID_RECORDS_SHAPE: 'INVALID_RECORDS_SHAPE',
    INVALID_PAGINATION_SHAPE: 'INVALID_PAGINATION_SHAPE',
    PAGINATION_METADATA_INVALID: 'PAGINATION_METADATA_INVALID',
    PAGINATION_METADATA_CONTRADICTORY: 'PAGINATION_METADATA_CONTRADICTORY',
    PAGE_NUMBER_MISMATCH: 'PAGE_NUMBER_MISMATCH',
    PAGINATION_SNAPSHOT_MISMATCH: 'PAGINATION_SNAPSHOT_MISMATCH',
    URL_BUILD_FAILED: 'URL_BUILD_FAILED',
    REQUEST_CAP_EXCEEDED: 'REQUEST_CAP_EXCEEDED',
    DUPLICATE_RECORD_ID: 'DUPLICATE_RECORD_ID',
    MERGED_LENGTH_MISMATCH: 'MERGED_LENGTH_MISMATCH'
  };

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }
  function isNonNegativeInteger(v) {
    return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
  }
  function isPositiveInteger(v) {
    return isFiniteNumber(v) && Number.isInteger(v) && v >= 1;
  }
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /**
   * Build the URL for a given page number, preserving every other existing
   * query parameter on baseUrl and overwriting (never duplicating) "page".
   *
   * Returns a structured result instead of throwing, so a malformed or
   * unresolvable URL fails closed at the call site rather than propagating
   * a raised exception. Absolute URLs are used as-is. Relative URLs are
   * resolved against `resolveBase` when given (the explicit Node-test
   * contract), else against `window.location.href` when running in a
   * browser, else parsing fails closed with URL_BUILD_FAILED.
   */
  function buildPageUrl(baseUrl, pageNumber, resolveBase) {
    if (typeof baseUrl !== 'string' || !baseUrl) {
      return { ok: false, errorCode: ERROR_CODES.URL_BUILD_FAILED, message: 'baseUrl must be a non-empty string.' };
    }
    var effectiveBase = resolveBase;
    if (!effectiveBase && typeof window !== 'undefined' && window.location && typeof window.location.href === 'string') {
      effectiveBase = window.location.href;
    }
    try {
      var url = effectiveBase ? new URL(baseUrl, effectiveBase) : new URL(baseUrl);
      url.searchParams.set('page', String(pageNumber));
      return { ok: true, url: url.toString() };
    } catch (err) {
      return { ok: false, errorCode: ERROR_CODES.URL_BUILD_FAILED, message: 'Failed to build page URL: ' + (err && err.message) };
    }
  }

  function validateResponseShape(data) {
    if (!isPlainObject(data)) {
      return { ok: false, errorCode: ERROR_CODES.INVALID_RESPONSE_SHAPE, message: 'Response body is not a plain object.' };
    }
    if (!Array.isArray(data.records)) {
      return { ok: false, errorCode: ERROR_CODES.INVALID_RECORDS_SHAPE, message: 'records is missing or not an array.' };
    }
    if (!isPlainObject(data.pagination)) {
      return { ok: false, errorCode: ERROR_CODES.INVALID_PAGINATION_SHAPE, message: 'pagination is missing or not a plain object.' };
    }
    return { ok: true };
  }

  /**
   * Validate an individual page's pagination metadata against its own
   * records length. Mirrors the backend contract in api/expenses.py:
   *   total_pages == max(1, ceil(total / per_page))
   */
  function validatePaginationMetadata(pagination, recordsLength) {
    var p = pagination;
    if (!isNonNegativeInteger(p.total)) {
      return { ok: false, errorCode: ERROR_CODES.PAGINATION_METADATA_INVALID, message: 'pagination.total is not a finite non-negative integer.' };
    }
    if (!isPositiveInteger(p.per_page)) {
      return { ok: false, errorCode: ERROR_CODES.PAGINATION_METADATA_INVALID, message: 'pagination.per_page is not a finite positive integer.' };
    }
    if (!isPositiveInteger(p.total_pages)) {
      return { ok: false, errorCode: ERROR_CODES.PAGINATION_METADATA_INVALID, message: 'pagination.total_pages is not a finite positive integer.' };
    }
    if (!isPositiveInteger(p.page)) {
      return { ok: false, errorCode: ERROR_CODES.PAGINATION_METADATA_INVALID, message: 'pagination.page is not a finite positive integer.' };
    }
    if (recordsLength > p.per_page) {
      return { ok: false, errorCode: ERROR_CODES.PAGINATION_METADATA_CONTRADICTORY, message: 'records.length exceeds pagination.per_page.' };
    }
    if (p.total === 0 && recordsLength !== 0) {
      return { ok: false, errorCode: ERROR_CODES.PAGINATION_METADATA_CONTRADICTORY, message: 'pagination.total is 0 but records is non-empty.' };
    }
    var expectedTotalPages = Math.max(1, Math.ceil(p.total / p.per_page));
    if (p.total_pages !== expectedTotalPages) {
      return {
        ok: false,
        errorCode: ERROR_CODES.PAGINATION_METADATA_CONTRADICTORY,
        message: 'pagination.total_pages (' + p.total_pages + ') is inconsistent with total/per_page (expected ' + expectedTotalPages + ').'
      };
    }
    return { ok: true };
  }

  /** Core pagination identity that must stay stable across every page of one load. */
  function paginationSnapshotsMatch(first, current) {
    return first.total === current.total &&
      first.total_pages === current.total_pages &&
      first.per_page === current.per_page;
  }

  /**
   * Fetch + validate a single page. firstPagination is null for page 1
   * itself, and the already-validated page-1 pagination object for every
   * subsequent page (used to enforce snapshot consistency).
   */
  async function fetchAndValidatePage(baseUrl, pageNumber, headers, fetchImpl, firstPagination, urlBase) {
    var urlResult = buildPageUrl(baseUrl, pageNumber, urlBase);
    if (!urlResult.ok) {
      return {
        ok: false,
        errorCode: urlResult.errorCode,
        message: urlResult.message,
        diagnostic: { pageNumber: pageNumber }
      };
    }
    var pageUrl = urlResult.url;

    var response;
    try {
      response = await fetchImpl(pageUrl, { headers: headers });
    } catch (err) {
      return {
        ok: false,
        errorCode: ERROR_CODES.NETWORK_ERROR,
        message: 'Network error while fetching page ' + pageNumber + ': ' + (err && err.message),
        diagnostic: { pageNumber: pageNumber }
      };
    }

    if (!response || !response.ok) {
      var status = response ? response.status : 'unknown';
      return {
        ok: false,
        errorCode: ERROR_CODES.HTTP_ERROR,
        message: 'HTTP error on page ' + pageNumber + ': status ' + status,
        diagnostic: { pageNumber: pageNumber, status: status }
      };
    }

    var data;
    try {
      data = await response.json();
    } catch (err) {
      return {
        ok: false,
        errorCode: ERROR_CODES.INVALID_JSON,
        message: 'Failed to parse JSON on page ' + pageNumber + ': ' + (err && err.message),
        diagnostic: { pageNumber: pageNumber }
      };
    }

    var shapeCheck = validateResponseShape(data);
    if (!shapeCheck.ok) {
      shapeCheck.diagnostic = { pageNumber: pageNumber };
      return shapeCheck;
    }

    var paginationCheck = validatePaginationMetadata(data.pagination, data.records.length);
    if (!paginationCheck.ok) {
      paginationCheck.diagnostic = { pageNumber: pageNumber };
      return paginationCheck;
    }

    if (data.pagination.page !== pageNumber) {
      return {
        ok: false,
        errorCode: ERROR_CODES.PAGE_NUMBER_MISMATCH,
        message: 'Requested page ' + pageNumber + ' but server returned pagination.page=' + data.pagination.page + '.',
        diagnostic: { pageNumber: pageNumber, returnedPage: data.pagination.page }
      };
    }

    if (firstPagination && !paginationSnapshotsMatch(firstPagination, data.pagination)) {
      return {
        ok: false,
        errorCode: ERROR_CODES.PAGINATION_SNAPSHOT_MISMATCH,
        message: 'pagination metadata on page ' + pageNumber + ' no longer matches the page-1 snapshot (total/total_pages/per_page changed).',
        diagnostic: { pageNumber: pageNumber, page1: firstPagination, current: data.pagination }
      };
    }

    return { ok: true, records: data.records, pagination: data.pagination };
  }

  /**
   * Track record_id values seen so far and detect cross-page duplicates.
   * Records missing a usable id are skipped for this check (their
   * uniqueness cannot be verified, and is not assumed).
   *
   * IDs are normalized with String() before comparison: the production
   * backend contract always emits record_id as a JSON string (Sheets-backed
   * "EXP-..."/"LEGACY-ROW-..." values), so 1 and "1" are treated as the same
   * ID. This only matters if a non-string id ever appears; it is a no-op for
   * every id the backend actually sends today.
   */
  function checkForDuplicateIds(records, idField, seenIds) {
    var ids = seenIds;
    for (var i = 0; i < records.length; i++) {
      var rawId = records[i] && records[i][idField];
      if (rawId === undefined || rawId === null || rawId === '') {
        continue;
      }
      var id = String(rawId);
      if (ids.has(id)) {
        return { ok: false, message: 'Duplicate ' + idField + ' detected across pages: ' + id };
      }
      ids.add(id);
    }
    return { ok: true };
  }

  function failure(errorCode, message, requestsMade, diagnostic) {
    return {
      ok: false,
      complete: false,
      records: [],
      errorCode: errorCode,
      message: message,
      requestsMade: requestsMade,
      diagnostic: diagnostic || {}
    };
  }

  /**
   * Fetch every page needed to obtain the complete expense record set,
   * validating pagination metadata and cross-page consistency throughout.
   * Fails closed (returns records: []) on any structural, metadata, cap,
   * or duplicate-id problem instead of returning a partial result.
   *
   * options:
   *   url            - string, base request URL (e.g. `${API_BASE}/api/expenses?per_page=500`)
   *   headers         - object, request headers
   *   fetchImpl       - function(url, opts) => Promise<Response-like>, required (injectable for tests)
   *   maxPageRequests - optional positive integer, defaults to MAX_PAGE_REQUESTS
   *   idField         - optional string, defaults to 'record_id'
   *   urlBase         - optional string, explicit base for resolving a relative
   *                      `url` (Node-test contract); browsers fall back to
   *                      window.location.href when this is omitted
   */
  async function fetchAllExpensePages(options) {
    options = options || {};
    var url = options.url;
    var headers = options.headers || {};
    var fetchImpl = options.fetchImpl;
    var maxPageRequests = isPositiveInteger(options.maxPageRequests) ? options.maxPageRequests : MAX_PAGE_REQUESTS;
    var idField = options.idField || 'record_id';
    var urlBase = options.urlBase;

    if (typeof url !== 'string' || !url) {
      return failure(ERROR_CODES.INVALID_INPUT, 'options.url must be a non-empty string.', 0, {});
    }
    if (typeof fetchImpl !== 'function') {
      return failure(ERROR_CODES.INVALID_INPUT, 'options.fetchImpl must be a function.', 0, {});
    }

    var requestsMade = 0;
    var seenIds = new Set();

    var firstPage = await fetchAndValidatePage(url, 1, headers, fetchImpl, null, urlBase);
    if (firstPage.errorCode !== ERROR_CODES.URL_BUILD_FAILED) {
      requestsMade += 1;
    }
    if (!firstPage.ok) {
      return failure(firstPage.errorCode, firstPage.message, requestsMade, firstPage.diagnostic);
    }

    var idCheck = checkForDuplicateIds(firstPage.records, idField, seenIds);
    if (!idCheck.ok) {
      return failure(ERROR_CODES.DUPLICATE_RECORD_ID, idCheck.message, requestsMade, { pageNumber: 1 });
    }

    var firstPagination = firstPage.pagination;
    var mergedRecords = firstPage.records.slice();

    if (mergedRecords.length === firstPagination.total) {
      return {
        ok: true,
        complete: true,
        records: mergedRecords,
        pagination: firstPagination,
        requestsMade: requestsMade
      };
    }

    var totalPages = firstPagination.total_pages;
    if (totalPages > maxPageRequests) {
      return failure(
        ERROR_CODES.REQUEST_CAP_EXCEEDED,
        'pagination.total_pages (' + totalPages + ') exceeds maxPageRequests (' + maxPageRequests + '); refusing to fetch further pages.',
        requestsMade,
        { totalPages: totalPages, maxPageRequests: maxPageRequests }
      );
    }

    for (var pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
      var page = await fetchAndValidatePage(url, pageNumber, headers, fetchImpl, firstPagination, urlBase);
      if (page.errorCode !== ERROR_CODES.URL_BUILD_FAILED) {
        requestsMade += 1;
      }
      if (!page.ok) {
        return failure(page.errorCode, page.message, requestsMade, page.diagnostic);
      }
      var pageIdCheck = checkForDuplicateIds(page.records, idField, seenIds);
      if (!pageIdCheck.ok) {
        return failure(ERROR_CODES.DUPLICATE_RECORD_ID, pageIdCheck.message, requestsMade, { pageNumber: pageNumber });
      }
      mergedRecords = mergedRecords.concat(page.records);
    }

    if (mergedRecords.length !== firstPagination.total) {
      return failure(
        ERROR_CODES.MERGED_LENGTH_MISMATCH,
        'Merged records length (' + mergedRecords.length + ') does not match pagination.total (' + firstPagination.total + ') declared on page 1.',
        requestsMade,
        { mergedLength: mergedRecords.length, declaredTotal: firstPagination.total }
      );
    }

    return {
      ok: true,
      complete: true,
      records: mergedRecords,
      pagination: firstPagination,
      requestsMade: requestsMade
    };
  }

  return {
    fetchAllExpensePages: fetchAllExpensePages,
    buildPageUrl: buildPageUrl,
    validateResponseShape: validateResponseShape,
    validatePaginationMetadata: validatePaginationMetadata,
    paginationSnapshotsMatch: paginationSnapshotsMatch,
    MAX_PAGE_REQUESTS: MAX_PAGE_REQUESTS,
    ERROR_CODES: ERROR_CODES
  };
});
