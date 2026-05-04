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

  // Generic multipart upload to Drive. Creates a new file (POST) or updates
  // an existing one (PATCH). Returns the parsed Drive response (which carries
  // `id` for the file). Used by ical.js and draw.js so the multipart
  // boilerplate lives in one place.
  async function uploadDriveFile(token, name, mimeType, content, existingFileId) {
    var boundary = 'minerva-boundary-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var metadata = { name: name, mimeType: mimeType };
    var body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mimeType + '\r\n\r\n' +
      content + '\r\n' +
      '--' + boundary + '--';
    var url, method;
    if (existingFileId) {
      url = 'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(existingFileId) +
            '?uploadType=multipart&fields=id,webViewLink';
      method = 'PATCH';
    } else {
      url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
      method = 'POST';
    }
    var resp = await fetch(url, {
      method: method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body: body
    });
    if (!resp.ok) {
      var text = await resp.text();
      var err = new Error('Drive upload ' + resp.status + ': ' + text.slice(0, 300));
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  // Generic Drive lookup by exact filename + optional mimeType. Visible
  // only to files the app itself created (drive.file scope).
  function findDriveFile(token, name, mimeType) {
    var qParts = ["name='" + name.replace(/'/g, "\\'") + "'", 'trashed=false'];
    if (mimeType) qParts.push("mimeType='" + mimeType + "'");
    var q = qParts.join(' and ');
    var url = 'https://www.googleapis.com/drive/v3/files' +
              '?q=' + encodeURIComponent(q) +
              '&fields=' + encodeURIComponent('files(id,name,modifiedTime)');
    return api(token, 'GET', url);
  }

  // Read the raw byte content of a Drive file (alt=media). Returns the
  // response text — callers parse JSON / decode as needed.
  async function getDriveFileContent(token, fileId) {
    var url = 'https://www.googleapis.com/drive/v3/files/' +
              encodeURIComponent(fileId) + '?alt=media';
    var resp = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!resp.ok) {
      var err = new Error('Drive read ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    return resp.text();
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.sheets = {
    findByName: findByName,
    findDriveFile: findDriveFile,
    getDriveFileContent: getDriveFileContent,
    createSpreadsheet: createSpreadsheet,
    getSpreadsheet: getSpreadsheet,
    batchUpdate: batchUpdate,
    getValues: getValues,
    updateValues: updateValues,
    appendValues: appendValues,
    spreadsheetUrl: spreadsheetUrl,
    uploadDriveFile: uploadDriveFile
  };
})();
