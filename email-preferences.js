(function (root) {
  'use strict';
  function create(options) {
    const doc = options.document || root.document, auth = options.auth;
    const call = options.functions.httpsCallable('manageDigestEmail');
    const youtube = !!doc.getElementById('yt-email-enabled');
    const ids = youtube ? { enabled: 'yt-email-enabled', email: 'yt-digest-email', hour: 'yt-digest-hour', status: 'yt-email-status', verify: 'yt-email-verify' }
      : { enabled: 'email-notif-toggle', email: 'email-address-input', hour: 'digest-time-select', status: 'digest-email-status', verify: 'digest-email-verify' };
    const element = name => doc.getElementById(ids[name]);
    let user = null, generation = 0, state = null, queue = Promise.resolve(), busy = false;
    const tokenMatch = /^#verify-email=([a-f0-9]{64})$/.exec(root.location.hash);
    let token = tokenMatch?.[1] || null;
    const persistent = () => user && !user.isAnonymous;
    const canEdit = () => persistent() && (!options.canEdit || options.canEdit());
    const message = value => { if (element('status')) element('status').textContent = value; };
    function render(next) {
      state = next;
      const button = element('verify');
      if (button) { button.hidden = !canEdit() || !state || state.verified || !state.desiredNotificationsEnabled; button.disabled = busy || !state?.verificationSendingAvailable; }
      if (!state) return;
      if (state.digestsSwitchedOff) { switchedOff(); return; }
      if (canEdit()) {
        element('enabled').checked = !!state.desiredNotificationsEnabled;
        element('email').value = state.email || '';
        if (element('hour')) element('hour').value = state.digestHour;
        if (youtube && typeof root.updateEmailFields === 'function') root.updateEmailFields();
        if (!youtube) {
          doc.getElementById('email-address-container').style.display = state.desiredNotificationsEnabled ? 'block' : 'none';
          doc.getElementById('digest-timing-container').style.display = state.desiredNotificationsEnabled ? 'flex' : 'none';
        }
      }
      if (!state.desiredNotificationsEnabled) message('Email digests are turned off.');
      else if (!state.verified) message('Address saved. Verify it before digests can be sent.' + (state.verificationSendingAvailable ? '' : ' Verification emails are temporarily unavailable.'));
      else if (!state.notificationsEnabled) message('Address verified. Email digests are turned off.');
      else message(state.verificationSendingAvailable ? 'Address verified. Email preferences saved.' : 'Address verified. Email delivery is temporarily unavailable.');
    }
    // Production beta (Decision 4): the server sends no email, so nobody can turn digests on.
    function switchedOff() {
      const text = 'Email digests are switched off during the beta.';
      const toggle = element('enabled');
      toggle.checked = false; toggle.disabled = true; toggle.title = text;
      if (element('verify')) element('verify').hidden = true;
      if (youtube) {
        if (typeof root.updateEmailFields === 'function') root.updateEmailFields();
        for (const id of ['yt-email-save', 'yt-email-upgrade']) { const button = doc.getElementById(id); if (button) button.hidden = true; }
        const hint = doc.getElementById('yt-email-access-hint'); if (hint) hint.textContent = '';
      } else {
        // The status line lives inside the address container, so show the container without the address field.
        doc.getElementById('email-address-container').style.display = 'block';
        element('email').hidden = true;
        doc.getElementById('digest-timing-container').style.display = 'none';
      }
      message(text);
    }
    async function invoke(action, data = {}) {
      const version = generation;
      if (!persistent()) { message('Sign in with the Google account that requested this email change.'); return null; }
      try {
        const result = (await call({ ...data, action })).data;
        if (version !== generation) return null;
        if (['status', 'save', 'confirm'].includes(action)) render(result);
        return result;
      } catch (error) {
        if (version === generation) message(error.code === 'functions/not-found' || error.code === 'functions/unavailable'
          ? 'Email settings are temporarily unavailable. Please try again later.' : error.message || 'Email settings could not be updated.');
        return null;
      }
    }
    function values() {
      return { email: element('email').value.trim(), notificationsEnabled: element('enabled').checked,
        digestHour: Number(element('hour').value), timezone: options.timezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
    }
    function save(input = values()) {
      const version = generation, copy = { ...input };
      const work = queue.then(() => version === generation ? invoke('save', copy) : null);
      queue = work.catch(() => {}); return work;
    }
    async function request() {
      if (busy || !canEdit()) return;
      const version = generation; busy = true;
      try {
        const saved = await save();
        if (version !== generation || !saved || saved.verified) return;
        if (!saved.verificationSendingAvailable) { message('Verification emails are temporarily unavailable. Your address is saved but is not enabled for delivery.'); return; }
        render(saved);
        const result = await invoke('request');
        if (version === generation && result?.sent) { await invoke('status'); if (version === generation) message('Verification email sent. Open its link within 15 minutes using this Google account.'); }
      } finally { if (version === generation) { busy = false; if (state) renderButton(); } }
    }
    function renderButton() {
      const button = element('verify'); if (button) button.disabled = busy || !state?.verificationSendingAvailable;
    }
    const unwatch = auth.onAuthStateChanged(next => {
      generation++; user = next; state = null; busy = false; message('');
      if (element('verify')) element('verify').hidden = true;
      if (!persistent()) { if (token) message('Sign in with the Google account that requested this email change.'); return; }
      if (token) {
        const value = token; token = null;
        const url = new URL(root.location.href); url.hash = ''; root.history.replaceState(null, '', url.href);
        invoke('confirm', { token: value });
      } else invoke('status');
    });
    element('verify')?.addEventListener('click', request);
    return { save, refresh: () => invoke('status'), request, destroy() { generation++; unwatch?.(); element('verify')?.removeEventListener('click', request); } };
  }
  root.DigestEmail = { create };
})(typeof window !== 'undefined' ? window : globalThis);
