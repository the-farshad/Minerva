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

  async function requestTokenViaPopup(clientId, prompt) {
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

  // ---- PKCE redirect flow --------------------------------------------------
  // Drop-in alternative to the GIS popup that survives Firefox
  // Enhanced Tracking Protection / Safari ITP / strict third-party
  // cookie blockers, because the auth happens inside a top-level
  // navigation to accounts.google.com (first-party for Google) rather
  // than an iframe / popup that needs cross-site cookies.

  var REDIR_KEY = 'minerva.auth.pkce.v1';

  function redirectUri() {
    return location.origin + location.pathname;
  }

  function randomVerifier() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  function base64url(bytesOrBuffer) {
    var bytes = bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : new Uint8Array(bytesOrBuffer);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256base64url(input) {
    var enc = new TextEncoder().encode(input);
    var digest = await crypto.subtle.digest('SHA-256', enc);
    return base64url(digest);
  }

  async function requestTokenViaRedirect(clientId, prompt) {
    if (!clientId) throw new Error('No OAuth client ID configured.');
    var verifier = randomVerifier();
    var challenge = await sha256base64url(verifier);
    var nonce = randomVerifier();
    sessionStorage.setItem(REDIR_KEY, JSON.stringify({
      clientId: clientId,
      verifier: verifier,
      state: nonce,
      returnTo: location.hash || '#/',
      ts: Date.now()
    }));
    var u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri());
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', nonce);
    u.searchParams.set('include_granted_scopes', 'true');
    if (prompt) u.searchParams.set('prompt', prompt);
    location.assign(u.toString());
    // Navigation in flight — never resolves. Ensures callers don't try
    // to render anything after this point.
    return new Promise(function () {});
  }

  // Called once on app boot. If the URL carries the OAuth `code` and
  // `state` params from a returning redirect, exchange the code for an
  // access token, restore the user's pre-redirect route, and clean
  // both query parameters from the address bar. Returns the access
  // token on success, null when there's nothing to consume.
  async function consumeRedirectCode() {
    var qs = location.search || '';
    if (!qs || qs.indexOf('code=') < 0) return null;
    var sp = new URLSearchParams(qs);
    var code = sp.get('code');
    var stateRet = sp.get('state');
    if (!code || !stateRet) return null;

    var raw = sessionStorage.getItem(REDIR_KEY);
    if (!raw) return null;
    var saved;
    try { saved = JSON.parse(raw); }
    catch (e) { sessionStorage.removeItem(REDIR_KEY); return null; }
    if (saved.state !== stateRet) {
      sessionStorage.removeItem(REDIR_KEY);
      throw new Error('OAuth state mismatch — refusing to exchange code.');
    }

    var resp;
    try {
      resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: saved.clientId,
          code: code,
          code_verifier: saved.verifier,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code'
        }).toString()
      });
    } catch (err) {
      sessionStorage.removeItem(REDIR_KEY);
      throw new Error('Token endpoint unreachable: ' + (err && err.message || err));
    }
    if (!resp.ok) {
      var body = await resp.text().catch(function () { return ''; });
      sessionStorage.removeItem(REDIR_KEY);
      throw new Error('Token exchange failed: HTTP ' + resp.status + ' ' + body.slice(0, 200));
    }
    var data = await resp.json();
    if (!data.access_token) {
      sessionStorage.removeItem(REDIR_KEY);
      throw new Error('No access_token in token response.');
    }

    state.access_token = data.access_token;
    state.expires_at = Date.now() + ((data.expires_in || 3600) * 1000) - 60000;
    persist();
    notify();
    fetchEmail(state.access_token).then(function (e) {
      if (e) { state.email = e; persist(); notify(); }
    });

    var returnTo = saved.returnTo || '#/';
    sessionStorage.removeItem(REDIR_KEY);
    history.replaceState(null, '', location.origin + location.pathname + returnTo);

    return state.access_token;
  }

  // Default to redirect flow, with the popup as an explicit fallback.
  // The popup path stays available so any caller that needs it (e.g.
  // a future "always silent re-auth" toggle) can still reach GIS.
  async function requestToken(clientId, prompt) {
    return requestTokenViaRedirect(clientId, prompt);
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
    requestTokenViaPopup: requestTokenViaPopup,
    requestTokenViaRedirect: requestTokenViaRedirect,
    consumeRedirectCode: consumeRedirectCode,
    signOut: signOut,
    getState: getState,
    onChange: onChange
  };
})();
