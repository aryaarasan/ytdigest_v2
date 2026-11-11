/* Shared by Classic and YouTube Edition. Beta demand tracking (2.6) and the Pro waitlist (2.7).
   Sends only fixed event names to our own backend: no third-party tracker, no free text. */
(function () {
  'use strict';
  // Decision 1 (8 Nov 2026): free-first beta. false restores the parked trial and checkout offer.
  const BETA_WAITLIST = true;
  const SOURCES = Object.freeze(['header', 'menu', 'summary-allowance', 'ask-allowance', 'saved', 'analytics', 'email', 'other']);
  const istDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } },
  };

  function create({ functions, getUser }) {
    let onWaitlist = false;
    let joining = false;
    let message = '';
    const panels = new Set();
    const send = data => functions.httpsCallable('recordBetaEvent')(data);
    const google = () => {
      const user = getUser();
      return !!user && !user.isAnonymous && Array.isArray(user.providerData) && user.providerData.some(p => p && p.providerId === 'google.com');
    };
    // Per-account browser memory so a returning member doesn't briefly see "Join" again.
    const waitlistKey = () => 'ytd-pro-waitlist:' + (getUser()?.uid || '');
    const markJoined = () => { onWaitlist = true; if (getUser()?.uid) storage.set(waitlistKey(), '1'); };
    const remember = result => { if (result?.data?.onWaitlist === true) markJoined(); update(); };
    const warn = error => console.warn('Beta activity could not be recorded:', error?.code || error?.message);

    // Once per account per day per browser; the server also counts each day once.
    function visit() {
      const user = getUser();
      onWaitlist = !!user?.uid && storage.get(waitlistKey()) === '1';
      update();
      if (!user?.uid) return Promise.resolve();
      const key = 'ytd-beta-visit:' + user.uid;
      const today = istDay();
      if (storage.get(key) === today) return Promise.resolve();
      return send({ event: 'visit' }).then(result => { storage.set(key, today); remember(result); }).catch(warn);
    }

    function upgradeOpened(source) {
      if (!getUser()?.uid) return Promise.resolve();
      return send({ event: 'upgrade_open', source: SOURCES.includes(source) ? source : 'other' }).then(remember).catch(warn);
    }

    async function join() {
      if (joining || onWaitlist) return;
      if (!google()) { message = ''; update(); return; }
      joining = true; message = ''; update();
      try {
        // A guest who just linked Google needs a fresh token before the server sees the Google sign-in.
        await getUser()?.getIdToken?.(true);
        await send({ event: 'waitlist_join' }); markJoined();
      }
      catch (error) { warn(error); message = 'Could not join right now. Please try again.'; }
      finally { joining = false; update(); }
    }

    function update() {
      for (const panel of panels) {
        if (!panel.isConnected) { panels.delete(panel); continue; }
        const button = panel.querySelector('.pi-join');
        const note = panel.querySelector('.pi-note');
        const status = panel.querySelector('.pi-status');
        if (onWaitlist) {
          button.hidden = false; button.disabled = true; button.textContent = '✓ You’re on the waitlist';
          note.textContent = 'We’ll email you once when Pro opens. Nothing else.';
        } else if (!google()) {
          button.hidden = true;
          note.textContent = 'Sign in with Google to join the waitlist, so we can tell you when Pro opens.';
        } else {
          button.hidden = false; button.disabled = joining; button.textContent = joining ? 'Joining…' : 'Join the Pro waitlist';
          note.textContent = 'We’ll email you once when Pro opens. No payment now.';
        }
        status.textContent = message;
      }
    }

    // Switch an Upgrade dialog into waitlist mode: hide [data-paid-offer], show [data-waitlist-only].
    function mount(overlay, { buttonClass = '' } = {}) {
      if (!BETA_WAITLIST || !overlay) return;
      if (!document.getElementById('pro-interest-style')) {
        const style = document.createElement('style');
        style.id = 'pro-interest-style';
        style.textContent = '.pi-panel{text-align:center;margin-top:8px}.pi-lead{font-size:15px;line-height:1.5;margin:0 0 14px}'
          + '.pi-note{font-size:12px;color:#999;margin:10px 0 0;line-height:1.5}.pi-status{font-size:12px;color:#ef4444;min-height:16px;margin:6px 0 0}'
          + '.pi-join:disabled{opacity:.75;cursor:default;transform:none}';
        document.head.appendChild(style);
      }
      overlay.querySelectorAll('[data-paid-offer]').forEach(element => { element.hidden = true; element.style.setProperty('display', 'none', 'important'); });
      overlay.querySelectorAll('[data-waitlist-only]').forEach(element => { element.hidden = false; });
      const panel = overlay.querySelector('[data-waitlist-panel]');
      if (!panel) return;
      panel.innerHTML = '<p class="pi-lead">Pro is coming. Join the waitlist and we’ll tell you when it opens.</p>'
        + '<button type="button" class="pi-join">Join the Pro waitlist</button>'
        + '<p class="pi-note"></p><p class="pi-status" role="status" aria-live="polite"></p>';
      panel.classList.add('pi-panel');
      if (buttonClass) panel.querySelector('.pi-join').classList.add(...String(buttonClass).split(/\s+/).filter(Boolean));
      panel.querySelector('.pi-join').addEventListener('click', join);
      panels.add(panel);
      update();
    }

    return { enabled: BETA_WAITLIST, visit, upgradeOpened, join, mount, refresh: update, get onWaitlist() { return onWaitlist; } };
  }
  window.ProInterest = { create, BETA_WAITLIST, SOURCES };
})();
