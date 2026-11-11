/* Shared sign-in flow. Linking preserves the guest UID and its server-owned data. */
(function (global) {
  'use strict';
  function messageFor(code, guest) {
    const unchanged = guest ? ' Your guest session is unchanged.' : '';
    if (['auth/credential-already-in-use', 'auth/email-already-in-use', 'auth/account-exists-with-different-credential'].includes(code)) {
      return guest ? 'That Google account already has a YTDigest profile. You are still a guest; nothing was moved. Choose another Google account to save this guest profile, or keep using this guest session.'
        : 'That account uses another sign-in method. Please use its original sign-in method; no accounts were merged.';
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'The Google window closed before sign-in finished.' + unchanged;
    if (code === 'auth/popup-blocked') return 'Your browser blocked Google sign-in. Allow the popup and try again.' + unchanged;
    if (code === 'auth/network-request-failed') return 'Sign-in could not connect. Check your connection and try again.' + unchanged;
    if (code === 'auth/too-many-requests') return 'Too many sign-in attempts. Please wait before trying again.' + unchanged;
    return 'Sign-in could not finish. Please try again. If Google was already linked, reload this page before trying again.';
  }

  const redirectKey = 'ytdigest.auth.redirect.v1';
  function create({ auth, createProvider, onMessage = () => {}, onBusy = () => {}, reload = () => {}, beforeReload = () => {}, confirm = () => false,
    preferRedirect = false, redirectStorage, now = () => Date.now() }) {
    let pending = false, reloading = false, observed = false, previousUid;
    function refresh() {
      if (reloading) return;
      reloading = true; beforeReload(); reload();
    }
    async function run(action, guest) {
      if (pending || reloading) return { ok: false, busy: true };
      pending = true; onBusy(true); onMessage('');
      try { return { ok: true, user: await action() }; }
      catch (error) { onMessage(messageFor(error.code, guest)); return { ok: false, code: error.code || 'auth/unknown' }; }
      finally { pending = false; onBusy(false); }
    }
    function google() {
      const guest = auth.currentUser?.isAnonymous ? auth.currentUser : null;
      return run(async () => {
        const provider = createProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        if (preferRedirect) {
          // Keep only flow identity in this tab; never store provider credentials.
          redirectStorage.setItem(redirectKey, JSON.stringify({ kind: guest ? 'link' : 'signin', uid: guest?.uid || null, startedAt: now() }));
          onMessage('Continuing to Google in this tab. Your guest progress stays with this session.');
          try {
            if (guest) await guest.linkWithRedirect(provider);
            else await auth.signInWithRedirect(provider);
          } catch (error) { redirectStorage.removeItem(redirectKey); throw error; }
          return null; // The current document leaves; the return is handled at startup.
        }
        onMessage('Complete Google sign-in in the popup. If no popup appears, allow popups for this site and reload before trying again.');
        // Do not sign out, switch identities, or copy protected Firestore fields.
        const result = guest ? await guest.linkWithPopup(provider) : await auth.signInWithPopup(provider);
        if (guest) {
          if (result.user?.uid !== guest.uid) throw new Error('Guest identity changed unexpectedly.');
          // Refresh claims so subsequent backend calls see the linked identity.
          await result.user.getIdToken(true);
          refresh();
        }
        return result.user;
      }, !!guest);
    }
    function guest() {
      if (auth.currentUser) return Promise.resolve({ ok: true, user: auth.currentUser });
      return run(async () => (await auth.signInAnonymously()).user, false);
    }
    let confirming = false;
    async function signOut() {
      if (pending || reloading || confirming) return { ok: false, busy: true };
      const warning = auth.currentUser?.isAnonymous
        ? 'Signing out ends access to this guest profile on this browser. To keep your channels, preferences and unlocked summaries, cancel and choose Save guest progress with Google first. Sign out anyway?'
        : 'Sign out of YTDigest? Your Google account data will be available when you sign in again.';
      confirming = true;
      let accepted;
      try { accepted = await confirm(warning); } finally { confirming = false; }
      if (!accepted) return { ok: false, canceled: true };
      return run(async () => { await auth.signOut(); refresh(); return null; }, false);
    }
    function acceptUser(user) {
      const uid = user?.uid || null;
      if (observed && previousUid !== uid) { refresh(); return false; }
      observed = true; previousUid = uid;
      return true;
    }
    async function finishRedirect() {
      let raw;
      try { raw = redirectStorage?.getItem(redirectKey); }
      catch { onMessage('This browser could not restore Google sign-in state. Your current session has been kept.'); return; }
      if (!raw) return;
      pending = true; onBusy(true);
      try {
        const marker = JSON.parse(raw);
        if (!['signin', 'link'].includes(marker.kind) || !Number.isFinite(marker.startedAt) || now() - marker.startedAt > 1800000
          || marker.startedAt > now() || (marker.kind === 'link' && typeof marker.uid !== 'string')) throw new Error('Invalid sign-in state.');
        const result = await auth.getRedirectResult();
        const user = result?.user;
        if (!user) { onMessage('Google sign-in did not finish. Your existing session has been kept; you can try again.'); return; }
        if (marker.kind === 'link' && user.uid !== marker.uid) throw new Error('Guest identity changed unexpectedly.');
        await user.getIdToken(true);
        onMessage('');
      } catch (error) {
        let guestFlow = false;
        try { guestFlow = JSON.parse(raw).kind === 'link'; } catch {}
        onMessage(messageFor(error.code, guestFlow));
      } finally {
        try { redirectStorage.removeItem(redirectKey); } catch {}
        pending = false; onBusy(false);
      }
    }
    return { google, guest, signOut, acceptUser, finishRedirect };
  }

  // In-page confirmation. Browser confirm() pop-ups are silently answered "Cancel"
  // by some embedded browsers, which made Sign out do nothing there.
  function confirmDialog(document, message, { confirmLabel = 'Sign out', cancelLabel = 'Cancel' } = {}) {
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const backdrop = document.createElement('div');
      backdrop.className = 'auth-confirm-backdrop';
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;background:#000b';
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
      dialog.style.cssText = 'box-sizing:border-box;width:420px;max-width:100%;padding:24px;background:#202020;color:#eee;border:1px solid #555;border-radius:14px;font:15px/1.6 system-ui,sans-serif';
      const text = document.createElement('p'); text.id = 'auth-confirm-message'; text.textContent = message; text.style.margin = '0 0 20px';
      dialog.setAttribute('aria-describedby', text.id);
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap';
      const button = (label, primary) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        b.style.cssText = `padding:9px 16px;border-radius:8px;font:inherit;cursor:pointer;border:1px solid ${primary ? '#b91c1c' : '#666'};background:${primary ? '#b91c1c' : 'transparent'};color:#fff`;
        return b;
      };
      const cancel = button(cancelLabel, false), accept = button(confirmLabel, true);
      const finish = value => { backdrop.remove(); if (previousFocus?.focus) previousFocus.focus(); resolve(value); };
      cancel.onclick = () => finish(false); accept.onclick = () => finish(true);
      backdrop.onclick = event => { if (event.target === backdrop) finish(false); };
      dialog.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === cancel ? accept : cancel).focus(); }
      };
      actions.append(cancel, accept); dialog.append(text, actions); backdrop.appendChild(dialog);
      document.body.appendChild(backdrop); cancel.focus();
    });
  }

  function mount({ auth, firebase, document, reload, beforeReload, confirm = message => confirmDialog(document, message), preferRedirect = false, redirectStorage }) {
    const notice = document.createElement('div');
    notice.id = 'auth-feedback'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    notice.hidden = true;
    notice.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10000;box-sizing:border-box;width:calc(100% - 32px);max-width:540px;padding:16px;background:#252525;color:#fff;border:1px solid #777;border-radius:12px;font:14px/1.6 system-ui;box-shadow:0 8px 32px #0008';
    const text = document.createElement('span');
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
    dismiss.style.cssText = 'margin-left:12px;background:transparent;color:#fff;border:1px solid #999;border-radius:6px;padding:4px 8px;cursor:pointer';
    dismiss.onclick = () => { notice.hidden = true; };
    notice.append(text, dismiss); document.body.appendChild(notice);
    const buttons = ['signin-btn', 'signin-guest-btn', 'save-guest-btn', 'signout-btn'].map(id => document.getElementById(id)).filter(Boolean);
    const session = create({ auth, createProvider: () => new firebase.auth.GoogleAuthProvider(), reload, beforeReload, confirm, preferRedirect, redirectStorage,
      onMessage(message) { text.textContent = message; notice.hidden = !message; },
      onBusy(busy) { for (const button of buttons) { button.disabled = busy; button.setAttribute('aria-busy', String(busy)); } },
    });
    document.getElementById('signin-btn').addEventListener('click', session.google);
    document.getElementById('signin-guest-btn').addEventListener('click', session.guest);
    document.getElementById('save-guest-btn').addEventListener('click', session.google);
    // Wait for the first restored Auth state before accepting clicks; an existing
    // guest must not be mistaken for a signed-out user during startup.
    for (const button of buttons) button.disabled = true;
    const ready = session.finishRedirect();
    return { ...session, ready, render(user) {
      for (const button of buttons) button.disabled = false;
      const button = document.getElementById('save-guest-btn');
      button.hidden = !user?.isAnonymous; button.style.display = user?.isAnonymous ? 'flex' : 'none';
    } };
  }
  const api = { create, mount, messageFor, redirectKey, confirmDialog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AuthSession = api;
})(typeof window === 'undefined' ? globalThis : window);
