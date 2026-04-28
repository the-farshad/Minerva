/* Minerva — Google Identity Services token client.
 *
 * Token-only flow (no redirect, no server). The user's access token is kept
 * in localStorage with an expiry timestamp; expired tokens trigger a silent
 * re-prompt. The OAuth client ID is BYO and read from minerva.config.v1.
 *
 * Exposes window.Minerva.auth:
 *   getToken(clientId)         async → access_token (silent if cached, prompts otherwise)
 *   requestToken(clientId, p)  async → token, with explicit prompt ("" | "consent" | "select_account")
 *   getState()                 → { hasToken, email }
 *   signOut()                  revokes + clears local state
 *   onChange(fn)               subscribe to state changes
 */
(function () {
  'use strict';

  var KEY = 'minerva.auth.v1';
  // Minimal scope set: drive.file lets the app see only files it created
  // or that the user explicitly opened with it (which is exactly what
  // Minerva needs — its own spreadsheet, nothing else). Sheets API
  // operations on those files work under drive.file, so we don't need
  // the broader, sensitive 'spreadsheets' scope. Keeping only
  // non-sensitive scopes also skips the "Google hasn't verified this app"
  // yellow warning at consent time.
  var SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
    'openid'
  ].join(' ');

  var tokenClient = null;
  var state = { access_token: null, expires_at: 0, email: null };
  var listeners = [];

  // restore from storage on load
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && typeof saved === 'object') {
      state.access_token = saved.access_token || null;
      state.expires_at = saved.expires_at || 0;
      state.email = saved.email || null;
    }
  } catch (e) { /* ignore */ }

  function persist() {
    if (!state.access_token) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(state));
  }

  function notify() {
    var s = getState();
    listeners.forEach(function (fn) { try { fn(s); } catch (e) { /* ignore */ } });
  }

  function gisReady() {
    return typeof google !== 'undefined' && google.accounts && google.accounts.oauth2;
  }

  async function waitForGIS(timeoutMs) {
    var start = Date.now();
    while (!gisReady()) {
      if (Date.now() - start > (timeoutMs || 10000)) {
        throw new Error('Google Sign-In failed to load. Check your network and try again.');
      }
      await new Promise(function (r) { setTimeout(r, 100); });
    }
  }

  function init(clientId) {
    if (tokenClient && tokenClient._clientId === clientId) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: function () { /* per-request override below */ }
    });
    tokenClient._clientId = clientId;
    return tokenClient;
  }

  async function fetchEmail(accessToken) {
    try {
      var r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      if (!r.ok) return null;
      var d = await r.json();
      return d.email || null;
    } catch (e) { return null; }
  }

  async function requestToken(clientId, prompt) {
    if (!clientId) throw new Error('No OAuth client ID configured.');
    await waitForGIS();
    var tc = init(clientId);
    return new Promise(function (resolve, reject) {
      tc.callback = function (resp) {
        if (resp && resp.error) {
          return reject(new Error(resp.error_description || resp.error));
        }
        if (!resp || !resp.access_token) {
          return reject(new Error('No access token returned.'));
        }
        state.access_token = resp.access_token;
        state.expires_at = Date.now() + ((resp.expires_in || 3600) * 1000) - 60000;
        persist();
        notify();
        // fetch email asynchronously; don't block the resolve
        fetchEmail(state.access_token).then(function (e) {
          if (e) { state.email = e; persist(); notify(); }
        });
        resolve(state.access_token);
      };
      try {
        tc.requestAccessToken({ prompt: prompt == null ? '' : prompt });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function getToken(clientId) {
    if (state.access_token && state.expires_at > Date.now()) {
      return state.access_token;
    }
    return requestToken(clientId, '');
  }

  function signOut() {
    var at = state.access_token;
    if (at && gisReady() && google.accounts.oauth2.revoke) {
      try { google.accounts.oauth2.revoke(at, function () {}); } catch (e) { /* ignore */ }
    }
    state.access_token = null;
    state.expires_at = 0;
    state.email = null;
    persist();
    notify();
  }

  function getState() {
    return {
      hasToken: !!(state.access_token && state.expires_at > Date.now()),
      email: state.email
    };
  }

  function onChange(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.auth = {
    getToken: getToken,
    requestToken: requestToken,
    signOut: signOut,
    getState: getState,
    onChange: onChange
  };
})();
