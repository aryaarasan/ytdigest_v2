/* Shared account allowance and private Pro preparation for both interfaces. */
(function () {
  'use strict';
  const fields = ['shortSummary', 'detailedSummary', 'sections', 'keyPoints'];
  function create({ functions, getUser, isPro, canPrepare = () => false, onVideo = () => {} }) {
    let account = null, allowance = null, observer = null, preparing = false;
    let currentVideos = [], observedVideos = [], filter = 'all';
    const unlocked = new Map(), jobs = new Map(), attempted = new Set();
    const queue = [];
    const toolbar = document.createElement('div');
    toolbar.className = 'sa-toolbar';
    toolbar.innerHTML = '<div class="sa-allowance" title="Each new summary counts once. Reopening is free."><span class="sa-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H5zM9 8h6M9 12h6M9 16h3"/></svg></span><div class="sa-meter"><strong class="sa-balance" aria-live="polite">Loading summaries…</strong><div class="sa-note">Resets at 12 AM IST</div><div class="sa-track" role="progressbar" aria-label="Daily summaries remaining" aria-valuemin="0"><span class="sa-fill"></span></div></div></div><div class="sa-controls"><select aria-label="Summary access filter"><option value="all">All videos</option><option value="unlocked">Unlocked in this view</option></select><button type="button" class="sa-session" hidden>Reading session</button></div><div class="sa-status" role="status" aria-live="polite"></div>';
    if (!document.getElementById('summary-access-style')) {
      const style = document.createElement('style'); style.id = 'summary-access-style';
      style.textContent = `
        .sa-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;max-width:1016px;padding:14px 0;margin:4px auto 0;border-bottom:1px solid #ffffff12;color:#eee;font-size:13px}
        .sa-allowance{display:flex;align-items:center;gap:11px;min-width:210px}
        .sa-symbol{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:11px;background:#ff704312;color:#ff956f}.sa-symbol svg{width:21px;height:21px}
        .sa-balance{display:flex;align-items:baseline;gap:5px;line-height:1.2;font-weight:500}.sa-count{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.5px}.sa-total{font-size:12px;color:#888}.sa-caption{font-size:12px;color:#ccc;margin-left:3px}
        .sa-note{font-size:10px;color:#929292;line-height:1.4;margin-top:3px}.sa-track{height:3px;width:112px;background:#303030;border-radius:3px;overflow:hidden;margin-top:5px}.sa-fill{display:block;height:100%;width:0;background:#e78360;border-radius:inherit;transition:width .2s}
        .sa-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sa-toolbar select,.sa-toolbar button,.sa-dialog button{background:#232323;color:#eee;border:1px solid #ffffff1f;border-radius:8px;padding:8px 12px;font:inherit}.sa-toolbar select{min-width:144px}.sa-toolbar button{font-weight:500}.sa-toolbar button:hover{background:#303030}.sa-toolbar :is(button,select):focus-visible{outline:2px solid #8ab4f8;outline-offset:3px}.sa-toolbar [hidden]{display:none!important}
        .sa-status{flex-basis:100%;font-size:12px;color:#aaa;line-height:1.5}.sa-status:empty{display:none}.sa-filtered-out{display:none!important}
        .sa-backdrop{position:fixed;inset:0;background:#000b;z-index:5000;display:flex;align-items:center;justify-content:center;padding:16px}.sa-dialog{width:560px;max-width:100%;max-height:85vh;overflow:auto;background:#202020;color:#eee;border:1px solid #555;border-radius:16px;padding:24px;font-size:14px}.sa-dialog h2{font-size:20px;margin:0 0 12px}.sa-dialog p{color:#bbb;line-height:1.6}.sa-choices label{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #383838;align-items:center}.sa-choices input{accent-color:#ff4d1c}.sa-dialog-actions{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}.sa-dialog button:disabled{opacity:.5}
        @media(max-width:600px){.sa-toolbar{padding:12px 0;gap:12px}.sa-controls{width:100%;flex-wrap:nowrap}.sa-toolbar select{min-width:0;flex:1}.sa-toolbar button{font-size:12px;white-space:nowrap}}
      `;
      document.head.appendChild(style);
    }
    toolbar.querySelector('select').onchange = event => { filter = event.target.value; observe(observedVideos); toolbar.querySelector('.sa-session').hidden = !isPro() || filter === 'unlocked'; };
    toolbar.querySelector('.sa-session').onclick = chooseSession;
    function identity() {
      const uid = getUser()?.uid || null;
      if (uid !== account) {
        account = uid; allowance = null; unlocked.clear(); jobs.clear(); attempted.clear(); queue.length = 0;
      }
      return uid;
    }
    function update(value) {
      if (!value) return;
      // Concurrent unlocks and focus refreshes can return out of order.
      if (allowance && value.day < allowance.day) return;
      if (allowance?.day === value.day && value.used < allowance.used) value = { ...value, used: allowance.used, remaining: Math.max(0, value.limit - allowance.used) };
      allowance = value;
      const balance = toolbar.querySelector('.sa-balance');
      balance.replaceChildren();
      if (value.developer) {
        balance.textContent = 'Developer access';
      } else {
        for (const [className, text] of [['sa-count', value.remaining], ['sa-total', `/ ${value.limit}`], ['sa-caption', 'summaries left']]) {
          const span = document.createElement('span'); span.className = className; span.textContent = text;
          if (balance.childNodes.length) balance.appendChild(document.createTextNode(' '));
          balance.appendChild(span);
        }
      }
      toolbar.querySelector('.sa-note').textContent = value.developer ? 'No daily limit' : 'Resets at 12 AM IST';
      const track = toolbar.querySelector('.sa-track');
      track.hidden = !!value.developer;
      track.setAttribute('aria-valuemax', value.limit);
      track.setAttribute('aria-valuenow', value.remaining);
      toolbar.querySelector('.sa-fill').style.width = `${Math.max(0, Math.min(100, value.limit ? value.remaining / value.limit * 100 : 0))}%`;
      toolbar.querySelector('.sa-session').hidden = !isPro() || filter === 'unlocked';
    }
    function patch(video, state) {
      fields.forEach(field => { video[field] = state.unlocked ? state[field] || (field === 'sections' || field === 'keyPoints' ? [] : '') : null; });
      video.unlocked = !!state.unlocked; video.prepared = !!state.ready;
      video.summaryState = video.shortSummary ? 'done' : 'pending';
      if (video.unlocked) unlocked.set(video.videoId, { ...state });
    }
    async function load(videos = []) {
      const uid = identity(); if (!uid) return;
      for (let start = 0; start < Math.max(1, videos.length); start += 30) {
        const batch = videos.slice(start, start + 30);
        // Clear bookmark payloads before requesting authoritative entitlements.
        batch.forEach(video => patch(video, unlocked.get(video.videoId) || { unlocked: false, ready: video.prepared }));
        let result;
        try { result = await functions.httpsCallable('getSummaryState')({ videoIds: batch.map(video => video.videoId) }); }
        catch (failure) { toolbar.querySelector('.sa-balance').textContent = 'Allowance unavailable. Refresh to retry.'; throw failure; }
        if (getUser()?.uid !== uid) return;
        update(result.data.allowance);
        result.data.videos.forEach(state => { const video = batch.find(v => v.videoId === state.videoId); if (video) patch(video, state); });
      }
    }
    async function unlock(video) {
      const uid = identity(); if (!uid) throw new Error('Sign in required.');
      const key = `${uid}:${video.videoId}`;
      if (jobs.has(key)) return jobs.get(key);
      const task = functions.httpsCallable('summarizeVideo', { timeout: 245000 })({
        videoId: video.videoId, unlockIntent: 'read', accessVersion: 2, title: video.title, channelName: video.channel || video.channelName || '',
        publishedAt: video.publishedAt || video.date || '', videoUrl: video.videoUrl || '',
      }).then(result => {
        if (getUser()?.uid !== uid) throw new Error('Account changed. Please reopen this summary.');
        update(result.data.allowance);
        patch(video, { ...result.data, unlocked: true, ready: true });
        onVideo(video); applyFilter();
        return result;
      }).finally(() => jobs.delete(key));
      jobs.set(key, task); return task;
    }
    async function drain() {
      if (preparing || document.hidden || !isPro() || !identity()) return;
      preparing = true;
      const uid = account;
      try {
        while (queue.length && !document.hidden && getUser()?.uid === uid && isPro()) {
          const video = queue.shift();
          const key = `${new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata'}).format(new Date())}:${video.videoId}`;
          if (video.prepared || video.unlocked || attempted.has(key)) continue;
          attempted.add(key);
          try {
            const result = await functions.httpsCallable('prepareSummary', { timeout: 245000 })({ videoId: video.videoId });
            if (getUser()?.uid !== uid) break;
            video.prepared = !!result.data.ready;
            onVideo(video); // Readiness only: no preview or breakdown is returned.
          } catch (failure) {
            if (failure.code === 'functions/resource-exhausted') { queue.length = 0; break; }
          }
        }
      } finally { preparing = false; }
    }
    function observe(videos) {
      identity();
      observedVideos = videos;
      applyFilter();
      const cards = [...document.querySelectorAll('.card[data-video-id]')].filter(card => card.getClientRects().length && !card.classList.contains('sa-filtered-out'));
      currentVideos = [...new Map(videos.filter(video => cards.some(card => card.dataset.videoId === video.videoId)).map(v => [v.videoId, v])).values()];
      observer?.disconnect(); queue.length = 0;
      applyFilter();
      if (!isPro() || !getUser() || getUser().isAnonymous || typeof IntersectionObserver === 'undefined') return;
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting && !entry.target.classList.contains('sa-filtered-out')) {
          const video = currentVideos.find(v => v.videoId === entry.target.dataset.videoId);
          if (video && canPrepare(video) && !video.unlocked && !video.prepared && !queue.includes(video)) queue.push(video);
        }
        drain();
      }, { threshold: 0.4 });
      document.querySelectorAll('.card[data-video-id]').forEach(card => observer.observe(card));
    }
    function applyFilter() {
      document.querySelectorAll('.card[data-video-id]').forEach(card => card.classList.toggle('sa-filtered-out', filter === 'unlocked' && !unlocked.has(card.dataset.videoId)));
      document.querySelectorAll('.date-group').forEach(group => group.classList.toggle('sa-filtered-out', filter === 'unlocked' && !group.querySelector('.card:not(.sa-filtered-out)')));
    }
    function chooseSession() {
      const candidates = currentVideos.filter(v => !v.unlocked).slice(0, 20);
      if (!candidates.length) { toolbar.querySelector('.sa-status').textContent = 'All videos in this view are already unlocked.'; return; }
      const previousFocus = document.activeElement;
      const overlay = document.createElement('div'); overlay.className = 'sa-backdrop';
      overlay.innerHTML = '<section class="sa-dialog" role="dialog" aria-modal="true" aria-label="Choose a reading session"><h2>Choose your reading session</h2><p>Each successful video unlock uses one allowance, whether prepared or new. Reopening costs nothing. Select up to your remaining allowance.</p><div class="sa-choices"></div><div class="sa-dialog-actions"><button type="button" class="sa-confirm">Unlock selected</button><button type="button" class="sa-cancel">Close</button></div><p class="sa-result" role="status" aria-live="polite"></p></section>';
      const boxes = candidates.map(video => {
        const label = document.createElement('label'), box = document.createElement('input'), text = document.createElement('span');
        box.type = 'checkbox'; text.textContent = video.title || video.videoId;
        label.append(box, text); overlay.querySelector('.sa-choices').appendChild(label);
        return { box, video };
      });
      const confirm = overlay.querySelector('.sa-confirm');
      const refresh = () => { const count = boxes.filter(item => item.box.checked).length; confirm.textContent = count ? `Unlock ${count} ${count === 1 ? 'video' : 'videos'}` : 'Select videos to unlock'; confirm.disabled = !count || (!allowance?.developer && count > (allowance?.remaining || 0)); };
      boxes.forEach(item => item.box.onchange = refresh); refresh();
      let running = false;
      const close = () => { if (running) return; overlay.remove(); previousFocus?.focus(); };
      overlay.querySelector('.sa-cancel').onclick = close;
      overlay.onkeydown = event => {
        if (event.key === 'Escape') close();
        if (event.key === 'Tab') {
          const controls = [...overlay.querySelectorAll('input,button')].filter(el => !el.disabled);
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
          else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
        }
      };
      confirm.onclick = async () => {
        running = true; confirm.disabled = true; confirm.textContent = 'Unlocking…'; let ready = 0, failed = 0;
        overlay.querySelector('.sa-cancel').disabled = true;
        overlay.querySelector('.sa-result').textContent = 'Unlocking the selected videos…';
        boxes.forEach(item => item.box.disabled = true);
        const selected = boxes.filter(item => item.box.checked);
        async function worker() {
          while (selected.length) {
            const item = selected.shift();
            try { await unlock(item.video); ready++; } catch (_) { failed++; }
            overlay.querySelector('.sa-result').textContent = `${ready} unlocked${failed ? `, ${failed} failed without a charge` : ''}.`;
          }
        }
        await Promise.all([worker(), worker()]);
        running = false; confirm.hidden = true; overlay.querySelector('.sa-cancel').disabled = false;
      };
      document.body.appendChild(overlay); boxes[0].box.focus();
    }
    function label(video) {
      return video.unlocked && video.shortSummary ? 'Full breakdown' : allowance?.developer ? 'Read summary' : video.unlocked ? 'Reopen summary' : video.prepared && isPro() ? 'Read instantly' : 'Read summary';
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(currentVideos).then(() => currentVideos.forEach(onVideo)).catch(() => {}); drain(); } });
    window.addEventListener('focus', () => { if (getUser()) load(currentVideos).then(() => currentVideos.forEach(onVideo)).catch(() => {}); });
    const timer = setInterval(() => { if (getUser() && !document.hidden && allowance && new Date() >= new Date(allowance.resetsAt)) load([]).catch(() => {}); }, 60000);
    window.addEventListener('pagehide', () => { clearInterval(timer); observer?.disconnect(); });
    return { load, unlock, observe, toolbar, label, isUnlocked: id => unlocked.has(id), get allowance() { return allowance; } };
  }
  window.SummaryAccess = { create };
})();
