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

  async function cognito(target, payload) {
    const endpoint = config.cognitoEndpoint || `https://cognito-idp.${config.region}.amazonaws.com/`; // override only for local testing
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
      body: JSON.stringify(payload),
    });
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

  function saveTokens(result, refreshToken) {
    const session = {
      idToken: result.IdToken,
      refreshToken: result.RefreshToken || refreshToken,
      user: profile(result.IdToken),
    };
    memory = session;
    store.set(session);
    return session;
  }

  /** Returns { session } when signed in, or { challenge } when Cognito needs more (new password, MFA code). */
  function handleAuthResult(data, username) {
    if (data.AuthenticationResult) return { session: saveTokens(data.AuthenticationResult) };
    return { challenge: { name: data.ChallengeName, session: data.Session, username } };
  }

  const Logbook = {
    configured: !!(config && config.apiUrl),

    async signIn(email, password) {
      const username = email.trim().toLowerCase();
      const data = await cognito('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH', ClientId: config.userPoolClientId, AuthParameters: { USERNAME: username, PASSWORD: password },
      });
      return handleAuthResult(data, username);
    },

    async answerChallenge(challenge, answer) {
      const responses = { USERNAME: challenge.username };
      if (challenge.name === 'NEW_PASSWORD_REQUIRED') responses.NEW_PASSWORD = answer;
      else if (challenge.name === 'SOFTWARE_TOKEN_MFA') responses.SOFTWARE_TOKEN_MFA_CODE = answer;
      else throw new Error(`Unsupported sign-in step: ${challenge.name}`);
      const data = await cognito('RespondToAuthChallenge', {
        ChallengeName: challenge.name, ClientId: config.userPoolClientId, Session: challenge.session, ChallengeResponses: responses,
      });
      return handleAuthResult(data, challenge.username);
    },

    session() { return store.get() || memory; },

    signOut() { store.clear(); memory = null; window.location.href = 'login.html'; },

    homeFor(user) {
      if (user.roles.includes('student')) return 'student_pwa_dashboard.html';
      if (user.roles.includes('supervisor') || user.roles.includes('lecturer')) return 'lecturer_dashboard.html';
      if (user.roles.includes('admin')) return 'admin_dashboard.html';
      return 'login.html';
    },

    /** Use at the top of a page: sends people to login if signed out, or home if they lack the role. */
    requireUser(...roles) {
      if (!Logbook.configured) return null;
      const s = Logbook.session();
      if (!s) { window.location.replace('login.html'); return null; }
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
      } catch {
        Logbook.signOut();
        throw new Error('Your session has ended. Please sign in again.');
      }
    },

    async api(method, path, body) {
      const s = await Logbook.refreshIfNeeded();
      const res = await fetch(config.apiUrl + path, {
        method,
        headers: { Authorization: s.idToken, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { Logbook.signOut(); throw new Error('Please sign in again.'); }
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
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
  };

  window.Logbook = Logbook;
})();
