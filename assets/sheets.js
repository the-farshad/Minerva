/* Minerva — thin Sheets API v4 + Drive API v3 wrapper.
 *
 * Every call takes the access token explicitly so callers stay honest about
 * auth lifecycle. Returns the parsed JSON from the API; throws on non-2xx
 * with the response body included.
 */
(function () {
  'use strict';

  async function api(token, method, url, body) {
    var resp = await fetch(url, {
      method: method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!resp.ok) {
      var text = await resp.text();
      var err = new Error(method + ' ' + url + ' → ' + resp.status + ': ' + text.slice(0, 400));
      err.status = resp.status;
      throw err;
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  // Drive: find spreadsheets owned by the user with a given exact name.
  // drive.file scope only sees files this app created — perfect for finding
  // an existing Minerva spreadsheet across reconnects.
  function findByName(token, name) {
    var q = "name='" + name.replace(/'/g, "\\'") + "' and " +
            "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    var url = 'https://www.googleapis.com/drive/v3/files' +
              '?q=' + encodeURIComponent(q) +
              '&fields=' + encodeURIComponent('files(id,name,modifiedTime,webViewLink)');
    return api(token, 'GET', url);
  }

  function createSpreadsheet(token, title, initialSheetTitle) {
    var body = { properties: { title: title } };
    if (initialSheetTitle) {
      body.sheets = [{ properties: { title: initialSheetTitle } }];
    }
    return api(token, 'POST', 'https://sheets.googleapis.com/v4/spreadsheets', body);
  }

  function getSpreadsheet(token, ssId) {
    return api(token, 'GET',
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId));
  }

  function batchUpdate(token, ssId, requests) {
    return api(token, 'POST',
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId) + ':batchUpdate',
      { requests: requests });
  }

  function getValues(token, ssId, range) {
    return api(token, 'GET',
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId) +
      '/values/' + encodeURIComponent(range));
  }

  function updateValues(token, ssId, range, values) {
    return api(token, 'PUT',
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId) +
      '/values/' + encodeURIComponent(range) +
      '?valueInputOption=USER_ENTERED',
      { values: values });
  }

  function appendValues(token, ssId, range, values) {
    return api(token, 'POST',
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId) +
      '/values/' + encodeURIComponent(range) +
      ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
      { values: values });
  }

  function spreadsheetUrl(ssId) {
    return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(ssId) + '/edit';
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.sheets = {
    findByName: findByName,
    createSpreadsheet: createSpreadsheet,
    getSpreadsheet: getSpreadsheet,
    batchUpdate: batchUpdate,
    getValues: getValues,
    updateValues: updateValues,
    appendValues: appendValues,
    spreadsheetUrl: spreadsheetUrl
  };
})();
