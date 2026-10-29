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
