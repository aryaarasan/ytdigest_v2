(function (root) {
  'use strict';
  function create(options) {
    const doc = options.document || root.document;
    const auth = options.auth, db = options.db;
    const call = options.functions.httpsCallable('createLemonSqueezyCheckout');
    const navigate = options.navigate || (url => root.location.assign(url));
    const reload = options.onAccessChanged || (() => root.location.reload());
    const style = doc.createElement('style');
    style.textContent = '#billing-dialog{color:var(--text,#eee);background:var(--bg,#181818);border:1px solid var(--border,#555);border-radius:16px;padding:24px;width:min(440px,calc(100vw - 32px));max-height:85vh;overflow:auto}#billing-dialog::backdrop{background:#0009}#billing-dialog h2{font-size:21px;margin:0 0 16px}#billing-dialog p{line-height:1.6}#billing-dialog button{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid #777;background:var(--surface,#292929);color:inherit;cursor:pointer;margin:6px 8px 0 0}#billing-dialog button:disabled{opacity:.55;cursor:wait}#billing-notice{position:fixed;top:72px;right:16px;z-index:10000;max-width:min(360px,calc(100vw - 32px));padding:12px 16px;background:#28364b;color:#fff;border:1px solid #7297cb;border-radius:10px;font:inherit;cursor:pointer}';
    doc.head.appendChild(style);
    const menu = doc.createElement('button');
    menu.type = 'button'; menu.className = 'dropdown-item'; menu.id = 'billing-menu'; menu.textContent = 'Subscription & billing'; menu.hidden = true;
    doc.getElementById('user-dropdown')?.appendChild(menu);
    const panel = doc.createElement('dialog'); panel.id = 'billing-dialog'; panel.setAttribute('aria-labelledby', 'billing-title');
    const title = doc.createElement('h2'); title.id = 'billing-title'; title.textContent = 'Subscription & billing';
    const status = doc.createElement('p'); status.id = 'billing-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const detail = doc.createElement('p');
    const button = (label, handler) => { const node = doc.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', handler); return node; };
    const refresh = button('Check status', () => update()); refresh.id = 'billing-refresh';
    const manage = button('Manage billing', () => openPortal()); manage.id = 'billing-manage'; manage.hidden = true;
    const resume = button('Continue checkout', () => checkout()); resume.id = 'billing-resume'; resume.hidden = true;
    const close = button('Close', () => { if (panel.close) panel.close(); else panel.removeAttribute('open'); menu.focus(); });
    panel.append(title, status, detail, refresh, manage, resume, close); doc.body.appendChild(panel);
    const notice = button('Check payment status', () => open()); notice.id = 'billing-notice'; notice.hidden = true; doc.body.appendChild(notice);
    let user = null, state = null, generation = 0, busy = false, poll = null, expiryTimer = null, unwatch = null, signature = null;
    let returned = new URL(root.location.href).searchParams.get('billing') === 'return';
    let attempts = 0;
    const persistent = () => user && !user.isAnonymous;
    const blocks = () => state && (['pending', 'review'].includes(state.state) || state.state === 'subscription' && state.status !== 'expired' && !(state.status === 'cancelled' && !state.paid));
    const dateText = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : ''; };
    function open() {
      doc.getElementById('user-dropdown')?.classList.remove('open');
      if (!panel.open) { if (panel.showModal) panel.showModal(); else panel.setAttribute('open', ''); }
      update();
    }
    function render() {
      manage.hidden = true; resume.hidden = true;
      refresh.disabled = !persistent() || busy; detail.textContent = '';
      if (!persistent()) { status.textContent = 'Sign in with the Google account used at checkout to check your subscription.'; return; }
      if (!state) { status.textContent = 'Checking your subscription…'; return; }
      if (state.state === 'pending') {
        status.textContent = state.canResume ? 'Your checkout is ready to continue.' : 'Waiting for payment confirmation.';
        detail.textContent = 'Pro activates after payment is verified. If you already paid, check status again rather than starting another purchase.';
        resume.hidden = !state.canResume;
      } else if (state.state === 'subscription') {
        const labels = { active: 'Subscription active', on_trial: 'Subscription trial active', cancelled: 'Subscription cancelled', expired: 'Subscription expired', past_due: 'Payment needs attention', unpaid: 'Payment overdue', paused: 'Subscription paused' };
        status.textContent = labels[state.status] || 'Subscription status needs review';
        detail.textContent = state.paid ? 'Pro access until ' + dateText(state.paidThrough) + '.' : 'This subscription currently has no paid Pro access. Any separate app trial is unchanged.';
        manage.hidden = !state.canManage;
      } else if (state.state === 'review') {
        status.textContent = 'Your billing association needs review.';
        detail.textContent = 'Please contact support before starting another purchase.';
      } else { status.textContent = 'No paid subscription on this account.'; detail.textContent = 'Returning from checkout alone does not activate Pro.'; }
      manage.disabled = busy; resume.disabled = busy;
      notice.hidden = state.state !== 'pending' && !returned;
      if (!notice.hidden) notice.textContent = state.state === 'pending' ? 'Payment status — check confirmation' : state.paid ? 'Payment confirmed — Pro is active' : 'Check subscription status';
    }
    async function update() {
      const version = generation;
      if (!persistent()) { render(); return; }
      clearTimeout(poll);
      try {
        const response = await call({ action: returned ? 'return' : 'status' });
        if (version !== generation) return;
        state = response.data;
        if (returned) {
          returned = false;
          const url = new URL(root.location.href); url.searchParams.delete('billing'); root.history.replaceState(null, '', url.href);
          notice.hidden = false;
        }
        render();
        if (state.state === 'pending' && !state.canResume && attempts++ < 6) poll = setTimeout(update, 5000);
      } catch { if (version === generation) status.textContent = 'Subscription status is temporarily unavailable. Please check again shortly.'; }
    }
    async function checkout() {
      if (busy) return;
      if (!persistent()) { open(); return; }
      if (blocks() && !(state.state === 'pending' && state.canResume)) { open(); return; }
      busy = true; render(); const version = generation;
      try {
        const response = await call({ action: 'checkout', edition: root.location.pathname.endsWith('youtube.html') ? 'youtube' : 'classic' });
        if (version !== generation) return;
        const destination = root.SafeContent.checkoutUrl(response.data.url);
        if (!destination) throw new Error('Checkout link could not be verified.');
        navigate(destination);
      } catch (error) { open(); status.textContent = error.message || 'Checkout is temporarily unavailable.'; }
      finally { busy = false; manage.disabled = false; resume.disabled = false; refresh.disabled = !persistent(); }
    }
    async function openPortal() {
      if (busy || !persistent()) return;
      busy = true; render(); const version = generation;
      try {
        const response = await call({ action: 'portal' });
        if (version !== generation) return;
        const destination = root.SafeContent.checkoutUrl(response.data.url);
        if (!destination || new URL(destination).pathname !== '/billing') throw new Error('Billing link could not be verified.');
        navigate(destination);
      } catch (error) { status.textContent = error.message || 'Billing is temporarily unavailable.'; }
      finally { busy = false; manage.disabled = false; refresh.disabled = !persistent(); }
    }
    const unauth = auth.onAuthStateChanged(next => {
      generation++; unwatch?.(); unwatch = null; clearTimeout(poll); clearTimeout(expiryTimer); attempts = 0;
      user = next; state = null; signature = null; busy = false; menu.hidden = !persistent();
      notice.hidden = !returned; render();
      if (returned) open();
      if (!persistent()) return;
      const reference = db.collection('users').doc(user.uid);
      const version = generation;
      if (reference.onSnapshot) unwatch = reference.onSnapshot(snapshot => {
        if (version !== generation) return;
        const data = snapshot.data() || {};
        const nextSignature = JSON.stringify([data.isPro, data.proUntil, data.lemonSqueezyStatus, data.trialEndsAt]);
        if (signature !== null && nextSignature !== signature) reload();
        signature = nextSignature;
        clearTimeout(expiryTimer);
        const until = [data.proUntil, data.trialEndsAt].map(value => value?.toDate ? value.toDate().getTime() : Date.parse(value)).filter(value => value > Date.now());
        if (until.length) expiryTimer = setTimeout(reload, Math.min(2147483647, Math.min(...until) - Date.now() + 100));
      }, () => {});
      update();
    });
    menu.addEventListener('click', open);
    return { open, checkout, blocksPurchase: blocks, destroy() {
      generation++; unauth?.(); unwatch?.(); clearTimeout(poll); clearTimeout(expiryTimer); [style, menu, panel, notice].forEach(node => node.remove());
    } };
  }
  root.PaymentClient = { create };
})(typeof window !== 'undefined' ? window : globalThis);
