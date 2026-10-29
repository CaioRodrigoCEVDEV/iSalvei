(function () {
  'use strict';

  function translate(key, params) {
    return window.i18n ? window.i18n.t(key, params) : key;
  }

  var toast = document.querySelector('[data-toast]');
  var toastTimer = null;
  var toastHideTimer = null;

  function showToast(message) {
    if (!toast || !message) return;
    if (toastTimer) clearTimeout(toastTimer);
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toast.textContent = message;
    toast.hidden = false;
    void toast.offsetWidth;
    toast.classList.add('is-visible');
    toastTimer = setTimeout(function () {
      toast.classList.remove('is-visible');
      toastHideTimer = setTimeout(function () {
        toast.hidden = true;
      }, 220);
    }, 6000);
  }

  /* ── instagram session ─────────────────────────────────────────────────── */

  var igSession = (function () {
    var modal = document.querySelector('[data-ig-modal]');
    var panel = document.querySelector('[data-ig-session]');
    var statusEl = document.querySelector('[data-ig-status]');
    var connectButtons = document.querySelectorAll('[data-ig-connect]');
    var disconnectButtons = document.querySelectorAll('[data-ig-disconnect]');
    var cookiesInput = document.querySelector('[data-ig-cookies]');
    var manualSubmit = document.querySelector('[data-ig-manual-submit]');
    var advancedEl = document.querySelector('[data-ig-advanced]');
    var errorEl = document.querySelector('[data-ig-error]');
    var closeButtons = document.querySelectorAll('[data-ig-cancel]');
    var loadingEl = document.querySelector('[data-ig-loading]');
    var screenEl = document.querySelector('[data-ig-screen]');
    var liveErrorEl = document.querySelector('[data-ig-live-error]');
    var liveErrorTextEl = document.querySelector('[data-ig-live-error-text]');
    var retryButton = document.querySelector('[data-ig-retry]');
    var controlsEl = document.querySelector('[data-ig-controls]');
    var remoteInput = document.querySelector('[data-ig-type]');
    var keyButtons = document.querySelectorAll('[data-ig-key]');
    var scrollButtons = document.querySelectorAll('[data-ig-scroll]');

    var connected = false;
    var busy = false;
    var pendingRetry = null;
    var lastFocus = null;
    var loginId = null;
    var stream = null;
    var screenWidth = 430;
    var screenHeight = 860;
    var lastInputValue = '';
    var startSeq = 0;

    function setError(key) {
      if (!errorEl) return;
      if (!key) {
        errorEl.hidden = true;
        errorEl.textContent = '';
        return;
      }
      errorEl.textContent = translate(key);
      errorEl.hidden = false;
    }

    function render() {
      if (panel) {
        panel.hidden = false;
        panel.classList.toggle('is-connected', connected);
      }
      if (statusEl) {
        statusEl.textContent = translate(connected ? 'instagram.connected' : 'instagram.not-connected');
      }
      for (var i = 0; i < connectButtons.length; i++) connectButtons[i].hidden = connected;
      for (var j = 0; j < disconnectButtons.length; j++) disconnectButtons[j].hidden = !connected;
    }

    function setLiveState(state) {
      if (loadingEl) loadingEl.hidden = state !== 'loading';
      if (screenEl) screenEl.hidden = state !== 'screen';
      if (liveErrorEl) liveErrorEl.hidden = state !== 'error';
      if (controlsEl) controlsEl.hidden = state !== 'screen';
    }

    function showLiveError(key, message) {
      setLiveState('error');
      if (liveErrorTextEl) liveErrorTextEl.textContent = message || translate(key || 'instagram.live.error');
      if (advancedEl && (key === 'instagram.live.unavailable' || key === 'instagram.live.busy')) {
        advancedEl.open = true;
      }
    }

    function liveErrorKey(code) {
      if (code === 'BROWSER_UNAVAILABLE' || code === 'BROWSER_ERROR') return 'instagram.live.unavailable';
      if (code === 'LOGIN_BUSY' || code === 'LOGIN_RATE_LIMITED') return 'instagram.live.busy';
      return 'instagram.live.error';
    }

    function cancelLive(keepalive) {
      startSeq++;
      if (stream) {
        try { stream.close(); } catch (error) {}
        stream = null;
      }
      if (loginId) {
        var id = loginId;
        loginId = null;
        fetch('/api/instagram/login/' + encodeURIComponent(id), {
          method: 'DELETE',
          credentials: 'same-origin',
          keepalive: Boolean(keepalive)
        }).catch(function () {});
      }
      lastInputValue = '';
      if (remoteInput) remoteInput.value = '';
    }

    function sendInput(payload) {
      if (!loginId) return;
      fetch('/api/instagram/login/' + encodeURIComponent(loginId) + '/input', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function (error) {
        console.error('[iSalvei] instagram input failed', error);
      });
    }

    function claimLogin() {
      if (!loginId) return;
      var id = loginId;
      loginId = null;
      if (stream) {
        try { stream.close(); } catch (error) {}
        stream = null;
      }

      fetch('/api/instagram/login/' + encodeURIComponent(id) + '/claim', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw body || {};
          return body;
        });
      }).then(function () {
        connected = true;
        render();
        var retry = pendingRetry;
        close();
        if (retry) retry();
      }).catch(function (error) {
        console.error('[iSalvei] instagram claim failed', error && error.code);
        showLiveError(error && error.code === 'LOGIN_PENDING' ? 'instagram.live.not-ready' : 'instagram.live.error');
      });
    }

    function handleStreamMessage(event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (message.type === 'frame') {
        screenWidth = Number(message.width) || 430;
        screenHeight = Number(message.height) || 860;
        if (screenEl) screenEl.src = 'data:image/jpeg;base64,' + message.image;
        setLiveState('screen');
      } else if (message.type === 'connected') {
        claimLogin();
      } else if (message.type === 'error') {
        showLiveError(null, message.message || translate('instagram.live.error'));
      }
    }

    function startLive() {
      cancelLive(false);
      setError(null);
      setLiveState('loading');
      if (advancedEl) advancedEl.open = false;

      var seq = ++startSeq;
      fetch('/api/instagram/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw body || { status: response.status };
          return body;
        });
      }).then(function (body) {
        if (seq !== startSeq) {
          if (body && body.id) {
            fetch('/api/instagram/login/' + encodeURIComponent(body.id), {
              method: 'DELETE',
              credentials: 'same-origin',
              keepalive: true
            }).catch(function () {});
          }
          return;
        }
        if (!body || !body.id) throw { code: 'BROWSER_ERROR' };

        loginId = body.id;
        stream = new EventSource('/api/instagram/login/' + encodeURIComponent(loginId) + '/stream');
        stream.onmessage = handleStreamMessage;
        stream.onerror = function () {
          if (connected || !loginId) return;
          showLiveError('instagram.live.disconnected');
        };

        if (remoteInput) remoteInput.value = '';
        lastInputValue = '';
      }).catch(function (error) {
        if (seq !== startSeq) return;
        console.error('[iSalvei] instagram live login failed', error && error.code);
        var key = liveErrorKey(error && error.code);
        showLiveError(key, key === 'instagram.live.error' ? (error && error.error) : null);
        if (advancedEl) advancedEl.open = true;
      });
    }

    function open(retry) {
      if (!modal) return;
      pendingRetry = typeof retry === 'function' ? retry : null;
      lastFocus = document.activeElement;
      setError(null);
      if (cookiesInput) cookiesInput.value = '';
      modal.hidden = false;
      document.body.classList.add('has-ig-modal');
      startLive();
    }

    function close() {
      if (!modal) return;
      if (loginId) cancelLive(false);
      modal.hidden = true;
      document.body.classList.remove('has-ig-modal');
      pendingRetry = null;
      setError(null);
      setLiveState('loading');
      if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus({ preventScroll: true }); } catch (error) { lastFocus.focus(); }
      }
    }

    function refresh() {
      return fetch('/api/instagram/session', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (response) {
        if (!response.ok) return null;
        return response.json();
      }).then(function (body) {
        if (!body) return;
        connected = Boolean(body.connected);
        render();
      }).catch(function () {
        // Servidor antigo ou offline: o painel simplesmente não é exibido.
        if (panel) panel.hidden = true;
      });
    }

    function submitManual() {
      if (!cookiesInput || busy) return;
      var value = cookiesInput.value.trim();
      if (!value) {
        setError('instagram.modal.invalid');
        cookiesInput.focus();
        return;
      }

      busy = true;
      if (manualSubmit) {
        manualSubmit.disabled = true;
        manualSubmit.classList.add('is-loading');
      }
      setError(null);

      fetch('/api/instagram/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ cookies: value })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw body || {};
          return body;
        });
      }).then(function () {
        connected = true;
        render();
        var retry = pendingRetry;
        close();
        if (retry) retry();
      }).catch(function (error) {
        console.error('[iSalvei] instagram manual session failed', error && error.code);
        setError(error && error.code === 'INVALID_COOKIES' ? 'instagram.modal.invalid' : 'instagram.modal.error');
      }).finally(function () {
        busy = false;
        if (manualSubmit) {
          manualSubmit.disabled = false;
          manualSubmit.classList.remove('is-loading');
        }
      });
    }

    function disconnect() {
      fetch('/api/instagram/session', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function () {
        connected = false;
        render();
        showToast(translate('instagram.disconnected'));
      }).catch(function (error) {
        console.error('[iSalvei] instagram disconnect failed', error);
      });
    }

    function screenPoint(event) {
      var rect = screenEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        x: Math.max(0, Math.min(screenWidth, (event.clientX - rect.left) / rect.width * screenWidth)),
        y: Math.max(0, Math.min(screenHeight, (event.clientY - rect.top) / rect.height * screenHeight))
      };
    }

    function commonPrefixLength(a, b) {
      var index = 0;
      while (index < a.length && index < b.length && a[index] === b[index]) index++;
      return index;
    }

    for (var i = 0; i < connectButtons.length; i++) {
      connectButtons[i].addEventListener('click', function () { open(null); });
    }
    for (var j = 0; j < disconnectButtons.length; j++) {
      disconnectButtons[j].addEventListener('click', disconnect);
    }
    for (var k = 0; k < closeButtons.length; k++) {
      closeButtons[k].addEventListener('click', close);
    }
    if (manualSubmit) manualSubmit.addEventListener('click', submitManual);
    if (retryButton) retryButton.addEventListener('click', startLive);

    if (screenEl) {
      screenEl.addEventListener('click', function (event) {
        var point = screenPoint(event);
        if (point) sendInput({ type: 'click', x: Math.round(point.x), y: Math.round(point.y) });
      });
      screenEl.addEventListener('wheel', function (event) {
        event.preventDefault();
        var point = screenPoint(event) || { x: screenWidth / 2, y: screenHeight / 2 };
        sendInput({ type: 'scroll', x: Math.round(point.x), y: Math.round(point.y), deltaY: event.deltaY });
      }, { passive: false });
    }

    if (remoteInput) {
      remoteInput.addEventListener('input', function () {
        if (!loginId) return;
        var value = remoteInput.value;
        var common = commonPrefixLength(value, lastInputValue);
        var removed = lastInputValue.length - common;
        var inserted = value.slice(common);

        var backspaces = Math.min(removed, 32);
        for (var index = 0; index < backspaces; index++) {
          sendInput({ type: 'key', key: 'Backspace' });
        }
        if (inserted) sendInput({ type: 'type', text: inserted });

        lastInputValue = value;
        if (value.length > 256) {
          remoteInput.value = '';
          lastInputValue = '';
        }
      });
      remoteInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          sendInput({ type: 'key', key: 'Enter' });
        }
      });
    }

    for (var m = 0; m < keyButtons.length; m++) {
      keyButtons[m].addEventListener('click', function () {
        sendInput({ type: 'key', key: this.getAttribute('data-ig-key') });
      });
    }
    for (var n = 0; n < scrollButtons.length; n++) {
      scrollButtons[n].addEventListener('click', function () {
        sendInput({
          type: 'scroll',
          x: screenWidth / 2,
          y: screenHeight / 2,
          deltaY: Number(this.getAttribute('data-ig-scroll')) || 0
        });
      });
    }

    if (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target === modal) close();
      });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && modal && !modal.hidden) close();
    });
    document.addEventListener('localechange', function () {
      if (panel && !panel.hidden) render();
    });
    window.addEventListener('pagehide', function () {
      if (loginId) cancelLive(true);
    });

    refresh();

    return {
      open: open,
      refresh: refresh,
      isConnected: function () { return connected; }
    };
  })();

  /* ── install prompt ────────────────────────────────────────────────────── */

  var btnInstall = document.getElementById('btnInstall');
  var deferredPrompt = null;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;

  if (btnInstall) {
    if (isIOS && !isStandalone) btnInstall.hidden = false;

    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferredPrompt = event;
      if (!isStandalone) btnInstall.hidden = false;
    });

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      btnInstall.hidden = true;
    });

    btnInstall.addEventListener('click', function () {
      if (!deferredPrompt) {
        showToast(translate('install.safari-prompt'));
        return;
      }

      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      btnInstall.disabled = true;

      promptEvent.prompt();
      promptEvent.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') btnInstall.hidden = true;
      }).catch(function (error) {
        console.error('[iSalvei] install prompt failed', error);
      }).finally(function () {
        btnInstall.disabled = false;
      });
    });
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */

  function filenameFromDisposition(disposition, contentType) {
    if (disposition) {
      var utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utf) {
        try {
          return decodeURIComponent(utf[1].trim());
        } catch (error) {
          console.warn('[iSalvei] invalid UTF-8 filename', error);
        }
      }

      var ascii = disposition.match(/filename="?([^";]+)"?/i);
      if (ascii) return ascii[1].trim();
    }

    var extension = String(contentType || 'video/mp4').split('/').pop().split(';')[0] || 'mp4';
    return 'isalvei-video.' + extension;
  }

  function normalizeVideoUrl(rawValue) {
    var value = String(rawValue || '').trim();

    if (!value) return { error: 'required' };
    if (/\s/.test(value)) return { error: 'invalid' };

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) {
        value = 'https://' + value;
      } else {
        return { error: 'invalid' };
      }
    }

    var parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      return { error: 'invalid' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'invalid' };
    }

    if (!parsed.hostname || (parsed.hostname.indexOf('.') === -1 && parsed.hostname.indexOf(':') === -1)) {
      return { error: 'invalid' };
    }

    return { value: parsed.href };
  }

  var API_ERROR_KEYS = {
    URL_REQUIRED: 'download.url-required',
    URL_UNRESOLVABLE: 'download.url-invalid',
    URL_TOO_LONG: 'download.url-invalid',
    URL_REDIRECT_LOOP: 'download.url-invalid',
    URL_NOT_ALLOWED: 'download.url-invalid',
    UNSUPPORTED_PLATFORM: 'download.error.unsupported',
    UNSUPPORTED_CONTENT: 'download.error.unsupported',
    NO_VIDEO: 'download.error.no-video',
    NO_AUDIO: 'download.error.no-audio',
    NOT_AVAILABLE: 'download.error.unavailable',
    AUTH_REQUIRED: 'download.error.private',
    GEO_BLOCKED: 'download.error.geo',
    DRM_PROTECTED: 'download.error.drm',
    LIVE_NOT_SUPPORTED: 'download.error.live',
    VIDEO_TOO_LONG: 'download.error.too-long',
    FILE_TOO_LARGE: 'download.error.too-large',
    UPSTREAM_OUTPUT_TOO_LARGE: 'download.error.too-large',
    PLATFORM_RATE_LIMITED: 'download.error.rate-limited',
    RATE_LIMITED: 'download.error.rate-limited',
    TIMEOUT: 'download.error.timeout',
    SERVER_BUSY: 'download.error.busy',
    UPSTREAM_UNAVAILABLE: 'download.error.platform',
    UPSTREAM_ERROR: 'download.error.platform',
    UPSTREAM_PARSE: 'download.error.platform',
    DEPENDENCY_MISSING: 'download.error.platform',
    DEPENDENCY_START_FAILED: 'download.error.platform',
    NO_OUTPUT: 'download.error.file',
    MEDIA_INVALID: 'download.error.file',
    STREAM_ERROR: 'download.error.server',
    TRANSCODE_FAILED: 'download.error.server',
    YTDLP_CONFIG: 'download.error.server',
    STORAGE_FULL: 'download.error.server',
    TMP_UNAVAILABLE: 'download.error.server',
    INTERNAL_ERROR: 'download.error.server',
    OFFLINE: 'download.error.network'
  };

  var FIELD_ERROR_CODES = {
    URL_REQUIRED: true,
    URL_UNRESOLVABLE: true,
    URL_TOO_LONG: true,
    URL_REDIRECT_LOOP: true,
    URL_NOT_ALLOWED: true
  };

  function mapApiError(info) {
    var code = info && info.code;
    var status = info && info.status;
    var retryAfter = Number(info && info.retryAfter);

    if (code === 'RATE_LIMITED' || code === 'PLATFORM_RATE_LIMITED' || status === 429) {
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return { key: 'download.error.rate-limited-retry', params: { seconds: retryAfter }, field: false };
      }
      return { key: 'download.error.rate-limited', field: false };
    }

    if (code && API_ERROR_KEYS[code]) {
      return { key: API_ERROR_KEYS[code], field: Boolean(FIELD_ERROR_CODES[code]) };
    }

    if (status === 403) return { key: 'download.error.private', field: false };
    if (status === 404) return { key: 'download.error.unavailable', field: false };
    if (status === 413) return { key: 'download.error.too-large', field: false };
    if (status === 504) return { key: 'download.error.timeout', field: false };
    if (status === 503) return { key: 'download.error.platform', field: false };
    if (status >= 500) return { key: 'download.error.server', field: false };

    return { key: 'download.error.unknown', field: false };
  }

  /* ── download form ─────────────────────────────────────────────────────── */

  document.querySelectorAll('[data-download-form]').forEach(function (form) {
    var card = form.closest('[data-download-card]') || form.parentElement;
    var urlInput = form.querySelector('[name="url"]');
    var formatInput = form.querySelector('[name="format"]');
    var pasteButton = form.querySelector('[data-paste]');
    var clearButton = form.querySelector('[data-clear]');
    var submitButton = form.querySelector('[type="submit"]');
    var submitLabel = form.querySelector('[data-submit-label]');
    var urlControl = form.querySelector('[data-url-control]');
    var fieldError = card.querySelector('[data-url-error]');
    var message = card.querySelector('[data-message]');
    var progressEl = card.querySelector('[data-download-progress]');
    var progressLabel = card.querySelector('[data-progress-label]');
    var processHint = card.querySelector('[data-process-hint]');
    var progressTrack = card.querySelector('[data-progress-track]');
    var progressBar = card.querySelector('[data-progress-bar]');
    var progressPct = card.querySelector('[data-progress-pct]');
    var readyEl = card.querySelector('[data-download-ready]');
    var readyFilename = card.querySelector('[data-ready-filename]');
    var triggerButton = card.querySelector('[data-download-trigger]');
    var resetButton = card.querySelector('[data-download-reset]');

    if (!urlInput || !submitButton) return;

    var state = {
      processing: false,
      phase: 'preparing',
      pendingBlob: null,
      pendingFilename: null,
      lastProgress: null,
      fieldErrorKey: null,
      messageKey: null,
      messageParams: null,
      messageType: null
    };

    function setSubmitLabel() {
      if (!submitLabel) return;
      submitLabel.textContent = translate(state.processing ? 'download.processing' : 'download.submit');
    }

    function syncClearButton() {
      if (!clearButton) return;
      clearButton.hidden = state.processing || !urlInput.value;
    }

    function setFieldError(key) {
      state.fieldErrorKey = key || null;
      if (!fieldError) return;

      if (key) {
        fieldError.textContent = translate(key);
        fieldError.hidden = false;
        urlInput.setAttribute('aria-invalid', 'true');
        if (urlControl) urlControl.classList.add('is-invalid');
      } else {
        fieldError.textContent = '';
        fieldError.hidden = true;
        urlInput.removeAttribute('aria-invalid');
        if (urlControl) urlControl.classList.remove('is-invalid');
      }
    }

    function setMessage(key, params, type) {
      state.messageKey = key || null;
      state.messageParams = params || null;
      state.messageType = type || null;

      if (!message) return;

      if (!key) {
        message.textContent = '';
        message.className = 'form-message';
        message.setAttribute('role', 'status');
        message.hidden = true;
        return;
      }

      message.textContent = translate(key, params);
      message.className = 'form-message is-' + (type || 'info');
      message.setAttribute('role', type === 'error' ? 'alert' : 'status');
      message.hidden = false;
    }

    function setFormDisabled(disabled) {
      urlInput.readOnly = disabled;
      if (formatInput) formatInput.disabled = disabled;
      if (pasteButton) pasteButton.disabled = disabled;
      if (clearButton) clearButton.disabled = disabled;
      submitButton.disabled = disabled;
      form.setAttribute('aria-busy', disabled ? 'true' : 'false');
    }

    function setPhase(phase) {
      state.phase = phase;

      if (!progressTrack || !progressBar) return;

      progressBar.style.width = '';
      progressTrack.classList.add('is-indeterminate');
      progressTrack.removeAttribute('aria-valuenow');

      if (phase === 'transferring') {
        if (progressLabel) progressLabel.textContent = translate('download.transferring');
        if (processHint) processHint.textContent = translate('download.transferring-hint');
        progressTrack.setAttribute('aria-valuetext', translate('download.transferring'));
      } else {
        if (progressLabel) progressLabel.textContent = translate('download.preparing');
        if (processHint) processHint.textContent = translate('download.preparing-hint');
        progressTrack.setAttribute('aria-valuetext', translate('download.preparing'));
      }

      if (progressPct) {
        progressPct.hidden = true;
        progressPct.textContent = '';
      }

      if (phase === 'transferring' && state.lastProgress) {
        setTransferProgress(state.lastProgress.received, state.lastProgress.total);
      }
    }

    function setTransferProgress(received, total) {
      if (!progressTrack || !progressBar || !progressPct) return;
      if (!total || total <= 0) return;

      state.lastProgress = { received: received, total: total };

      var percent = Math.max(0, Math.min(100, Math.round((received / total) * 100)));
      progressTrack.classList.remove('is-indeterminate');
      progressTrack.removeAttribute('aria-valuetext');
      progressTrack.setAttribute('aria-valuenow', String(percent));
      progressBar.style.width = percent + '%';
      progressPct.hidden = false;
      progressPct.textContent = percent + '%';
    }

    function beginProcessing() {
      state.processing = true;
      state.pendingBlob = null;
      state.pendingFilename = null;
      state.lastProgress = null;
      if (readyEl) readyEl.hidden = true;
      setFormDisabled(true);
      setSubmitLabel();
      submitButton.classList.add('is-loading');
      setFieldError(null);
      setMessage(null);
      syncClearButton();
      if (progressEl) progressEl.hidden = false;
      setPhase('preparing');
    }

    function finishProcessing() {
      state.processing = false;
      setFormDisabled(false);
      submitButton.classList.remove('is-loading');
      setSubmitLabel();
      syncClearButton();
      if (progressEl) progressEl.hidden = true;
    }

    function readBlob(response, total) {
      var contentType = response.headers.get('Content-Type') || 'application/octet-stream';

      if (!response.body || typeof response.body.getReader !== 'function') {
        return response.blob();
      }

      var reader = response.body.getReader();
      var chunks = [];
      var received = 0;

      function readNext() {
        return reader.read().then(function (result) {
          if (result.done) {
            return new Blob(chunks, { type: contentType });
          }

          if (result.value) {
            chunks.push(result.value);
            received += result.value.byteLength;
            setTransferProgress(received, total);
          }

          return readNext();
        });
      }

      return readNext().catch(function (error) {
        try { reader.cancel(); } catch (ignored) {}
        console.error('[iSalvei] transfer failed', error);
        throw { type: 'network' };
      });
    }

    function triggerDownload() {
      if (!state.pendingBlob || !state.pendingFilename) {
        setMessage('download.error.file', null, 'error');
        return;
      }

      if (state.pendingBlob.size === 0) {
        setMessage('download.error.file', null, 'error');
        return;
      }

      try {
        var blobUrl = URL.createObjectURL(state.pendingBlob);
        var anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = state.pendingFilename;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 30000);
      } catch (error) {
        console.error('[iSalvei] trigger download failed', error);
        setMessage('download.error.file', null, 'error');
      }
    }

    function showReady(blob, filename) {
      state.pendingBlob = blob;
      state.pendingFilename = filename;

      if (readyFilename) readyFilename.textContent = filename;
      finishProcessing();
      if (readyEl) {
        readyEl.hidden = false;
        triggerDownload();
        try {
          readyEl.focus({ preventScroll: true });
        } catch (error) {
          readyEl.focus();
        }
      } else {
        triggerDownload();
      }
    }

    function handleError(error) {
      finishProcessing();

      if (error && error.type === 'api') {
        var info = error.info || {};
        var isInstagram = /(^|\.)instagram\.com$|(^|\.)instagr\.am$/i.test(
          (function () {
            try { return new URL(urlInput.value).hostname; } catch (ignored) { return ''; }
          })()
        );

        if (info.loginRequired && isInstagram) {
          setFieldError(null);
          setMessage('instagram.required', null, 'error');
          igSession.open(function () {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit(submitButton);
            } else {
              form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            }
          });
          return;
        }

        var mapped = mapApiError(info);
        if (mapped.field) {
          setMessage(null);
          setFieldError(mapped.key);
          urlInput.focus();
        } else {
          setFieldError(null);
          setMessage(mapped.key, mapped.params, 'error');
        }
        return;
      }

      if (error && error.type === 'empty') {
        setFieldError(null);
        setMessage('download.error.file', null, 'error');
        return;
      }

      setFieldError(null);
      setMessage('download.error.network', null, 'error');
    }

    async function downloadVideo(event) {
      event.preventDefault();
      if (state.processing) return;

      var normalized = normalizeVideoUrl(urlInput.value);
      if (!normalized.value) {
        setMessage(null);
        setFieldError(normalized.error === 'required' ? 'download.url-required' : 'download.url-invalid');
        urlInput.focus();
        return;
      }

      var format = formatInput ? formatInput.value : 'best';
      urlInput.value = normalized.value;
      setFieldError(null);
      setMessage(null);
      beginProcessing();

      try {
        var params = new URLSearchParams({ url: normalized.value, format: format });
        var response = await fetch('/api/download?' + params.toString());
        var retryAfter = parseInt(response.headers.get('Retry-After'), 10);

        if (!response.ok) {
          var body = {};
          try {
            body = await response.json();
          } catch (ignored) {}

          var info = {
            status: response.status,
            code: body.code,
            error: body.error,
            requestId: body.requestId,
            retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0
          };

          console.error('[iSalvei] download failed', info);
          throw { type: 'api', info: info };
        }

        setPhase('transferring');
        var total = Number(response.headers.get('Content-Length')) || 0;
        if (total > 0) setTransferProgress(0, total);

        var blob = await readBlob(response, total);
        if (!blob || blob.size === 0) throw { type: 'empty' };

        var filename = filenameFromDisposition(
          response.headers.get('Content-Disposition'),
          response.headers.get('Content-Type')
        );

        showReady(blob, filename);
      } catch (error) {
        if (error && error.type) {
          handleError(error);
        } else {
          console.error('[iSalvei] unexpected download error', error);
          handleError({ type: 'network' });
        }
      }
    }

    function pasteFromClipboard() {
      if (state.processing) return;

      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
        setMessage('download.clipboard-error', null, 'error');
        urlInput.focus();
        return;
      }

      navigator.clipboard.readText().then(function (clipboardText) {
        if (state.processing) return;

        var value = String(clipboardText || '').trim();
        if (!value) {
          setMessage('download.clipboard-empty', null, 'error');
          urlInput.focus();
          return;
        }

        urlInput.value = value;
        setFieldError(null);
        setMessage('download.pasted', null, 'info');
        syncClearButton();
        urlInput.focus();
        urlInput.select();
      }).catch(function () {
        if (state.processing) return;
        setMessage('download.clipboard-error', null, 'error');
        urlInput.focus();
      });
    }

    function clearUrl() {
      if (state.processing) return;
      urlInput.value = '';
      setFieldError(null);
      setMessage(null);
      syncClearButton();
      urlInput.focus();
    }

    function resetDownload() {
      state.pendingBlob = null;
      state.pendingFilename = null;
      if (readyEl) readyEl.hidden = true;
      if (progressEl) progressEl.hidden = true;
      setFieldError(null);
      setMessage(null);
      urlInput.value = '';
      finishProcessing();
      urlInput.focus();
    }

    if (pasteButton) pasteButton.addEventListener('click', pasteFromClipboard);
    if (clearButton) clearButton.addEventListener('click', clearUrl);
    if (triggerButton) triggerButton.addEventListener('click', triggerDownload);
    if (resetButton) resetButton.addEventListener('click', resetDownload);

    urlInput.addEventListener('input', function () {
      if (state.processing) return;
      setFieldError(null);
      setMessage(null);
      syncClearButton();
    });

    form.addEventListener('submit', downloadVideo);

    document.addEventListener('localechange', function () {
      setSubmitLabel();
      if (state.fieldErrorKey) {
        if (fieldError) fieldError.textContent = translate(state.fieldErrorKey);
      }
      if (state.messageKey) {
        if (message) message.textContent = translate(state.messageKey, state.messageParams);
      }
      if (progressEl && !progressEl.hidden) setPhase(state.phase);
    });

    syncClearButton();
  });

  document.addEventListener('localechange', function () {
    if (btnInstall) {
      var label = btnInstall.querySelector('[data-install-label]');
      if (label) label.textContent = translate('install.btn');
    }
  });
})();
