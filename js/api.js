/*
 * Logbook browser client: Cognito sign-in (no SDK needed) and calls to the logbook API.
 * Tokens live in sessionStorage so they are cleared when the tab closes — important when a
 * student hands their phone to a supervisor.
 */
(function () {
  'use strict';
  const config = window.LOGBOOK_CONFIG;
  const KEY = 'logbook.session';

  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } },
    set(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage blocked: session lasts this page only */ } },
    clear() { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
  };
  let memory = null; // fallback when sessionStorage is unavailable

  function decodeJwt(token) {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(part).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    return JSON.parse(json);
  }

  function groupsOf(claims) {
    const g = claims['cognito:groups'];
    return Array.isArray(g) ? g : typeof g === 'string' ? g.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean) : [];
  }

  function profile(idToken) {
    const c = decodeJwt(idToken);
    return {
      sub: c.sub, email: c.email, name: c.name || c.email, roles: groupsOf(c),
      institution: c['custom:institution'] || '', category: c['custom:category'] || null, regNo: c['custom:reg_no'] || '',
      exp: c.exp,
    };
  }

  const offlineError = () => Object.assign(new Error('No connection. Check your signal and try again.'), { offline: true });

  async function cognito(target, payload) {
    const endpoint = config.cognitoEndpoint || `https://cognito-idp.${config.region}.amazonaws.com/`; // override only for local testing
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
        body: JSON.stringify(payload),
      });
    } catch { throw offlineError(); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const type = String(data.__type || '').split('#').pop();
      const friendly = {
        NotAuthorizedException: 'Incorrect email or password.',
        UserNotFoundException: 'Incorrect email or password.',
        PasswordResetRequiredException: 'Your password must be reset. Ask your administrator.',
        InvalidPasswordException: data.message || 'That password does not meet the rules.',
        CodeMismatchException: 'That code is not right. Try again.',
        TooManyRequestsException: 'Too many attempts. Wait a minute and try again.',
      }[type];
      throw new Error(friendly || data.message || 'Sign-in failed.');
    }
    return data;
  }

  function saveTokens(result, refreshToken, persist = true) {
    const session = {
      idToken: result.IdToken,
      refreshToken: result.RefreshToken || refreshToken,
      user: profile(result.IdToken),
    };
    if (persist) { memory = session; store.set(session); }
    return session;
  }

  /**
   * Returns { session } when signed in, or { challenge } when Cognito needs more (new password, MFA code).
   * persist: false keeps the session in the caller's hands only (hand-over signing on someone else's phone).
   */
  function handleAuthResult(data, username, persist) {
    if (data.AuthenticationResult) return { session: saveTokens(data.AuthenticationResult, undefined, persist) };
    return { challenge: { name: data.ChallengeName, session: data.Session, username, persist } };
  }

  const NEXT = 'logbook.next';
  const safeNext = (v) => (typeof v === 'string' && /^[a-z_]+\.html(\?[A-Za-z0-9_=&%.-]*)?$/.test(v) ? v : null);

  const Logbook = {
    configured: !!(config && config.apiUrl),

    async signIn(email, password, { persist = true } = {}) {
      const username = email.trim().toLowerCase();
      const data = await cognito('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH', ClientId: config.userPoolClientId, AuthParameters: { USERNAME: username, PASSWORD: password },
      });
      return handleAuthResult(data, username, persist);
    },

    async answerChallenge(challenge, answer) {
      const responses = { USERNAME: challenge.username };
      if (challenge.name === 'NEW_PASSWORD_REQUIRED') responses.NEW_PASSWORD = answer;
      else if (challenge.name === 'SOFTWARE_TOKEN_MFA') responses.SOFTWARE_TOKEN_MFA_CODE = answer;
      else throw new Error(`Unsupported sign-in step: ${challenge.name}`);
      const data = await cognito('RespondToAuthChallenge', {
        ChallengeName: challenge.name, ClientId: config.userPoolClientId, Session: challenge.session, ChallengeResponses: responses,
      });
      return handleAuthResult(data, challenge.username, challenge.persist !== false);
    },

    /** Ends a session that was never stored (hand-over): revokes its refresh token so it can't be reused. */
    async revoke(session) {
      if (!session?.refreshToken) return;
      try { await cognito('RevokeToken', { Token: session.refreshToken, ClientId: config.userPoolClientId }); } catch { /* best effort */ }
    },

    /** Where to go after signing in: the page that sent us to login, else the role's home page. */
    afterSignIn(user) {
      let next = null;
      try { next = safeNext(sessionStorage.getItem(NEXT)); sessionStorage.removeItem(NEXT); } catch { /* ignore */ }
      return next || Logbook.homeFor(user);
    },

    session() { return store.get() || memory; },

    signOut() {
      const waiting = Logbook.session() ? Logbook.outbox.list().length : 0;
      if (waiting && !confirm(`${waiting} entr${waiting === 1 ? 'y is' : 'ies are'} still waiting to upload. They stay on this phone and upload the next time you sign in here. Sign out?`)) return;
      store.clear(); memory = null; window.location.href = 'login.html';
    },

    homeFor(user) {
      if (user.roles.includes('student')) return 'student_pwa_dashboard.html';
      if (user.roles.includes('supervisor') || user.roles.includes('lecturer')) return 'lecturer_dashboard.html';
      if (user.roles.includes('admin')) return 'admin_users.html';
      return 'login.html';
    },

    /** Use at the top of a page: sends people to login if signed out, or home if they lack the role. */
    requireUser(...roles) {
      if (!Logbook.configured) return null;
      const s = Logbook.session();
      if (!s) {
        try { sessionStorage.setItem(NEXT, location.pathname.split('/').pop() + location.search); } catch { /* ignore */ }
        window.location.replace('login.html');
        return null;
      }
      if (roles.length && !roles.some((r) => s.user.roles.includes(r))) { window.location.replace(Logbook.homeFor(s.user)); return null; }
      return s.user;
    },

    async refreshIfNeeded() {
      const s = Logbook.session();
      if (!s) throw new Error('Not signed in');
      if (s.user.exp * 1000 - Date.now() > 60_000) return s;
      try {
        const data = await cognito('InitiateAuth', {
          AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: config.userPoolClientId, AuthParameters: { REFRESH_TOKEN: s.refreshToken },
        });
        return saveTokens(data.AuthenticationResult, s.refreshToken);
      } catch (err) {
        if (err.offline) throw err; // no signal: keep the session, try again later
        Logbook.signOut();
        throw new Error('Your session has ended. Please sign in again.');
      }
    },

    async api(method, path, body) {
      const s = await Logbook.refreshIfNeeded();
      return request(s.idToken, method, path, body, () => Logbook.signOut());
    },

    /** Calls the API as a session that isn't stored (hand-over). No refresh: these sessions last minutes. */
    apiAs(session, method, path, body) {
      return request(session.idToken, method, path, body, () => { throw new Error('The supervisor session has ended. Sign in again.'); });
    },
  };

  async function request(idToken, method, path, body, on401) {
      let res;
      try {
        res = await fetch(config.apiUrl + path, {
          method,
          headers: { Authorization: idToken, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch { throw offlineError(); }
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { on401(); throw new Error('Please sign in again.'); }
      if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, fields: data.fields });
      return data;
  }

  // ---------------- offline support ----------------
  const local = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  const userKey = (name) => `logbook.${name}.${Logbook.session()?.user.sub || 'anon'}`;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  let syncing = null;

  Object.assign(Logbook, {
    /**
     * GET with a per-user copy kept on the phone. Without signal, returns the saved copy with
     * { offline: true, savedAt } so the page can say how old it is.
     */
    async cachedGet(path) {
      const key = userKey('cache') + path;
      try {
        const data = await Logbook.api('GET', path);
        local.set(key, { savedAt: new Date().toISOString(), data });
        return { ...data, offline: false };
      } catch (err) {
        const saved = err.offline && local.get(key, null);
        if (saved) return { ...saved.data, offline: true, savedAt: saved.savedAt };
        throw err;
      }
    },

    /** Entries logged without signal, kept on this phone (per student) until they upload. */
    outbox: {
      list() { return local.get(userKey('outbox'), []); },
      add(body) {
        const item = { clientId: uuid(), recordedAt: Date.now(), body, status: 'waiting' };
        if (!local.set(userKey('outbox'), [...Logbook.outbox.list(), item])) throw new Error('This phone is out of storage space, so the entry could not be saved.');
        return item;
      },
      remove(clientId) { local.set(userKey('outbox'), Logbook.outbox.list().filter((i) => i.clientId !== clientId)); },
      /** Uploads waiting entries one by one. Safe to call often: only one sync runs at a time. */
      sync() {
        if (syncing) return syncing;
        syncing = (async () => {
          const result = { uploaded: 0, problems: 0, offline: false };
          for (const item of Logbook.outbox.list().filter((i) => i.status === 'waiting')) {
            try {
              await Logbook.api('POST', '/entries', { ...item.body, clientId: item.clientId, recordedAt: item.recordedAt });
              Logbook.outbox.remove(item.clientId);
              result.uploaded++;
            } catch (err) {
              if (err.offline) { result.offline = true; break; }
              if (err.status >= 400 && err.status < 500) {
                local.set(userKey('outbox'), Logbook.outbox.list().map((i) => (i.clientId === item.clientId ? { ...i, status: 'problem', error: err.message } : i)));
                result.problems++;
              } else { result.offline = true; break; } // server trouble: try again later
            }
          }
          return result;
        })().finally(() => { syncing = null; });
        return syncing;
      },
    },

    /** A small "no connection" bar that follows the phone's connection state. */
    mountConnectivity() {
      const bar = document.createElement('p');
      bar.className = 'notice notice-info offline-bar';
      bar.setAttribute('role', 'status');
      bar.textContent = 'No connection. You can keep logging; entries upload when you have signal.';
      const update = () => { bar.hidden = navigator.onLine !== false; };
      update();
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      document.querySelector('.container').prepend(bar);
    },

    /** Escapes text for safe insertion into HTML. Use for every value that came from the API. */
    esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    },

    formatDate(iso) {
      const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
      return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
    },

    /** Shows a message in an element with role=status/alert. kind: 'error' | 'ok' | 'info' */
    notice(el, text, kind = 'error') {
      el.textContent = text;
      el.className = `notice notice-${kind}`;
      el.hidden = !text;
    },

    /** Header strip with who's signed in and a sign-out button. */
    mountUserBar(user) {
      const bar = document.createElement('div');
      bar.className = 'user-bar';
      bar.innerHTML = `<span>${Logbook.esc(user.name)} · ${Logbook.esc(user.roles.join(', '))}${user.category ? ' · ' + Logbook.esc(user.category) : ''}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-button';
      btn.textContent = 'Sign out';
      btn.addEventListener('click', Logbook.signOut);
      bar.appendChild(btn);
      document.querySelector('.container').prepend(bar);
    },

    /** Shown on live pages when no backend is configured. */
    demoNotice() {
      const p = document.createElement('p');
      p.className = 'notice notice-info';
      p.innerHTML = 'Demo mode: no backend is configured, so this page cannot load real data. Deploy the backend (see backend/README.md) to use it.';
      document.querySelector('.container').prepend(p);
    },
  });

  window.Logbook = Logbook;

  // Cache the app on the phone so it opens without signal (see sw.js). Not on file:// or in tests.
  if (Logbook.configured && 'serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ }); });
  }
})();
