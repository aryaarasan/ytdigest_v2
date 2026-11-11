(function (root) {
  'use strict';
  function start(firebase, config, { hostname = root.location?.hostname, document = root.document, log = root.console } = {}) {
    const state = { status: 'disabled' };
    function status(value) {
      state.status = value;
      if (!document) return;
      let meta = document.querySelector('meta[name="ytdigest-app-check"]');
      if (!meta) { meta = document.createElement('meta'); meta.name = 'ytdigest-app-check'; document.head.appendChild(meta); }
      meta.content = value;
    }
    status('disabled');
    if (!config || config.mode === 'off') return state;
    if (config.mode !== 'monitor' || firebase.app().options.projectId !== 'ytdigest-v2-staging'
      || !['ytdigest-v2-staging.web.app', 'ytdigest-v2-staging.firebaseapp.com'].includes(hostname)
      || typeof config.siteKey !== 'string' || !/^[\w-]{30,100}$/.test(config.siteKey)) {
      status('unavailable'); return state;
    }
    try {
      const check = firebase.appCheck();
      check.activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(config.siteKey), true);
      status('monitoring');
      check.onTokenChanged(result => status(result?.token ? 'token-ready' : 'monitoring'), () => status('unavailable'));
    } catch {
      status('unavailable'); log?.warn('App verification is unavailable; monitoring mode keeps sign-in available.');
    }
    return state;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { start };
  else root.AppAttestation = { start };
})(typeof globalThis === 'object' ? globalThis : this);
