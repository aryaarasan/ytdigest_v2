/* Shared by Classic and YouTube Edition. Preparing a summary never records an open. */
(function () {
  'use strict';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function create({ functions, getUser, isPro, onUpgrade }) {
    const pendingOpens = new Map();
    let root = null;
    let chart = null;
    let requestVersion = 0;
    let selectedPeriod = 'month';

    async function recordOpen(video) {
      const user = getUser();
      if (!user || !video?.videoId || !video.shortSummary) return;
      const key = `${user.uid}:${video.videoId}`;
      if (pendingOpens.has(key)) return pendingOpens.get(key);
      const promise = functions.httpsCallable('recordSummaryOpen')({
        videoId: video.videoId, timezone: timezone(), durationSeconds: video.durationSeconds || null,
      }).then(() => {
        if (root?.isConnected && root.getClientRects().length) load();
      }).catch(error => console.warn('Summary activity could not be recorded:', error.code || error.message))
        .finally(() => pendingOpens.delete(key));
      pendingOpens.set(key, promise);
      return promise;
    }

    function destroy() {
      requestVersion++;
      if (chart) chart.destroy();
      chart = null;
      root = null;
    }

    async function load() {
      if (!root?.isConnected || !isPro()) return;
      const target = root;
      const version = ++requestVersion;
      const status = target.querySelector('.da-status');
      status.textContent = 'Loading your activity…';
      try {
        const result = await functions.httpsCallable('getSummaryAnalytics')({ timezone: timezone() });
        if (version !== requestVersion || root !== target || !target.isConnected) return;
        const period = result.data.periods[selectedPeriod];
        target.querySelector('.da-total').textContent = period.total;
        target.querySelector('.da-time').textContent = `${period.estimatedMinutesSaved} mins`;
        status.textContent = period.total ? '' : 'Open a summary to start seeing your activity here.';
        target.querySelector('.da-zone').textContent = `Dates use ${result.data.timezone}. Weeks start on Monday.`;
        target.querySelector('.da-channels').innerHTML = period.channels.length
          ? period.channels.map(ch => `<li><span>${escapeHtml(ch.name)}</span><strong>${ch.count}</strong></li>`).join('')
          : '<li>No summaries opened in this period.</li>';
        const daily = period.daily;
        target.querySelector('.da-chart-description').textContent = daily.map(d => `${d.day}: ${d.count}`).join('; ');
        if (chart) { chart.destroy(); chart = null; }
        if (typeof Chart !== 'undefined') {
          chart = new Chart(target.querySelector('canvas').getContext('2d'), {
            type: 'line',
            data: {
              labels: daily.map(d => d.day.slice(5)),
              datasets: [{ label: 'Unique summaries opened', data: daily.map(d => d.count),
                borderColor: '#ff6b45', backgroundColor: 'rgba(255,107,69,.12)', fill: true, tension: 0.15, pointRadius: 3 }],
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: { y: { beginAtZero: true, ticks: { precision: 0, color: '#aaa' } }, x: { ticks: { color: '#aaa', maxTicksLimit: 10 } } },
            },
          });
        } else {
          target.querySelector('.da-chart-description').classList.remove('da-sr-only');
        }
      } catch (error) {
        if (version !== requestVersion || root !== target) return;
        status.textContent = 'Activity could not be loaded. Please try Refresh.';
        console.warn('Analytics unavailable:', error.code || error.message);
      }
    }

    function render(container) {
      destroy();
      root = container;
      if (!document.getElementById('digest-analytics-style')) {
        const style = document.createElement('style');
        style.id = 'digest-analytics-style';
        style.textContent = `
          .digest-analytics{width:100%;max-width:800px;margin:0 auto;padding:24px 0;color:#f1f1f1}
          .digest-analytics h2{font-weight:700;font-size:22px;line-height:1.4;margin:0 0 20px}
          .da-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
          .da-toolbar label{font-size:14px}.da-toolbar select,.da-toolbar button{background:#272727;color:#fff;border:1px solid #555;border-radius:8px;padding:8px 12px;font:inherit}
          .da-stats{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
          .da-stat,.da-chart-box{background:#1e1e1e;border:1px solid #383838;border-radius:12px;padding:20px}
          .da-label,.da-note,.da-zone,.da-status{color:#aaa;font-size:13px;line-height:1.6}
          .da-total,.da-time{font-size:32px;font-weight:800;margin-top:6px}.da-time{color:#4ade80}
          .da-chart-box h3{font-size:16px;margin:0 0 16px}.da-chart{height:240px;position:relative}
          .da-note,.da-zone{margin-top:14px}.da-status{min-height:24px;margin-bottom:12px}
          .da-channels{list-style:none;padding:0;margin:12px 0}.da-channels li{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid #333}
          .da-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
          @media(max-width:480px){.da-stats{grid-template-columns:1fr}.da-stat,.da-chart-box{padding:16px}}
        `;
        document.head.appendChild(style);
      }
      if (!isPro()) {
        container.innerHTML = '<div class="digest-analytics"><h2>Your viewing analytics</h2><p>Track summaries you open and estimated time saved with Pro.</p><button class="da-upgrade" style="margin-top:16px;color:#ff815e">Upgrade to Pro</button></div>';
        container.querySelector('.da-upgrade').onclick = onUpgrade;
        return;
      }
      container.innerHTML = `<section class="digest-analytics">
        <h2>Your viewing analytics</h2>
        <div class="da-toolbar"><label>Show <select aria-label="Analytics period">
          <option value="today">Today</option><option value="week">This week</option><option value="month">This month</option>
        </select></label><button class="da-refresh">Refresh</button></div>
        <div class="da-status" role="status" aria-live="polite"></div>
        <div class="da-stats"><div class="da-stat"><div class="da-label">Unique summaries opened</div><div class="da-total">—</div></div>
          <div class="da-stat"><div class="da-label">Estimated time saved</div><div class="da-time">—</div></div></div>
        <div class="da-chart-box"><h3>Daily summary activity</h3><div class="da-chart"><canvas role="img" aria-label="Daily unique summaries opened"></canvas></div><p class="da-chart-description da-sr-only"></p></div>
        <h3 style="font-size:16px;margin-top:24px">Top channels</h3><ul class="da-channels"></ul>
        <p class="da-note">Each video counts once per selected period. The chart counts unique videos each day. Activity tracking starts with this update.</p>
        <p class="da-note">Time saved estimates video length minus summary reading time. A 15 minute video is assumed when its length is unavailable.</p>
        <p class="da-zone"></p></section>`;
      const select = container.querySelector('select');
      select.value = selectedPeriod;
      select.onchange = () => { selectedPeriod = select.value; load(); };
      container.querySelector('.da-refresh').onclick = load;
      return load();
    }

    window.addEventListener('focus', () => {
      if (root?.isConnected && root.getClientRects().length) load();
    });
    return { recordOpen, render, destroy };
  }
  window.DigestAnalytics = { create };
})();
