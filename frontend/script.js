(function () {
  var _t = window.i18n ? window.i18n.t : function (k) { return k; };

  var deferredPrompt;
  var btnInstall = document.getElementById("btnInstall");
  if (!btnInstall) return;

  var isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    btnInstall.style.display = "block";
  });

  btnInstall.addEventListener("click", function () {
    btnInstall.style.display = "none";
    if (!deferredPrompt) {
      if (isiOS || isSafari) {
        alert(_t('install.safari-prompt'));
      }
      return;
    }
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function (choiceResult) {
      console.log("Usu\u00e1rio escolheu:", choiceResult.outcome);
      deferredPrompt = null;
    });
  });

  function filenameFromDisposition(disposition, contentType) {
    var utf = disposition && disposition.match(/filename\*=UTF-8''([^;]+)/i);
    var ascii = disposition && disposition.match(/filename="?([^";]+)"?/i);
    if (utf) return decodeURIComponent(utf[1]);
    if (ascii) return ascii[1];
    var ext = (contentType || 'video/mp4').split('/').pop().split(';')[0] || 'mp4';
    return 'isalvei-video.' + ext;
  }

  function updatePasteButton(btn, input) {
    if (!btn) return;
    btn.textContent = input && input.value ? _t('download.clear') : _t('download.paste');
  }

  document.querySelectorAll('[data-download-form]').forEach(function (form) {
    var urlInput = form.querySelector('[name="url"]');
    var formatInput = form.querySelector('[name="format"]');
    var pasteButton = form.querySelector('[data-paste]');
    var submitButton = form.querySelector('[type="submit"]');
    var card = form.closest('[data-download-card]') || form.parentElement;
    var message = card.querySelector('[data-message]');

    function setMessage(text, type) {
      if (!message) return;
      message.textContent = text || '';
      message.classList.remove('error', 'success');
      if (type) message.classList.add(type);
    }

    var formRow = card.querySelector('.form-row');
    var progressEl = card.querySelector('[data-download-progress]');
    var progressLabel = card.querySelector('[data-progress-label]');
    var progressBar = card.querySelector('[data-progress-bar]');
    var progressPct = card.querySelector('[data-progress-pct]');
    var readyEl = card.querySelector('[data-download-ready]');
    var downloadTrigger = readyEl && readyEl.querySelector('[data-download-trigger]');
    var pendingBlob = null;
    var pendingFilename = null;
    var progressTimer = null;

    function showProcessing() {
      submitButton.disabled = true;
      formRow.hidden = true;
      progressEl.hidden = false;
      readyEl.hidden = true;
      if (message) message.textContent = '';
      progressLabel.textContent = _t('download.processing');
      progressBar.style.transition = 'width .4s ease';
      progressBar.style.width = '0%';
      progressPct.textContent = '';
      var pct = 0;
      progressTimer = setInterval(function () {
        pct += Math.max(1, Math.round((90 - pct) * 0.08));
        if (pct >= 90) { pct = 90; clearInterval(progressTimer); }
        progressBar.style.width = pct + '%';
        progressPct.textContent = pct + '%';
      }, 400);
    }

    function showDownloadReady() {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      progressBar.style.transition = 'width .2s ease';
      progressBar.style.width = '100%';
      progressPct.textContent = '100%';
      setTimeout(function () {
        progressEl.hidden = true;
        readyEl.hidden = false;
      }, 400);
    }

    function triggerDownload() {
      if (!pendingBlob) return;
      var blobUrl = URL.createObjectURL(pendingBlob);
      var anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = pendingFilename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(blobUrl);
      displaySuccess(pendingFilename);
      pendingBlob = null;
      pendingFilename = null;
      readyEl.hidden = true;
      formRow.hidden = false;
      submitButton.disabled = false;
    }

    function cancelProcessing() {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      progressEl.hidden = true;
      readyEl.hidden = true;
      formRow.hidden = false;
      submitButton.disabled = false;
    }

    function displaySuccess(filename) {
      var maxLen = 40;
      var isTruncated = filename.length > maxLen;
      var displayName = isTruncated ? filename.slice(0, maxLen) + '\u2026' : filename;

      if (!message) return;
      message.innerHTML = '';
      message.className = 'msg success';

      var textSpan = document.createElement('span');
      textSpan.textContent = _t('download.started', { filename: displayName });
      message.appendChild(textSpan);

      if (isTruncated) {
        var toggle = document.createElement('button');
        toggle.className = 'msg-toggle';
        toggle.textContent = _t('download.show-full');
        toggle.type = 'button';
        (function (full) {
          toggle.addEventListener('click', function () {
            var expanded = toggle.dataset.expanded === 'true';
            if (expanded) {
              textSpan.textContent = _t('download.started', { filename: displayName });
              toggle.dataset.expanded = 'false';
              toggle.textContent = _t('download.show-full');
            } else {
              textSpan.textContent = _t('download.started', { filename: full });
              toggle.dataset.expanded = 'true';
              toggle.textContent = _t('download.show-less');
            }
          });
        })(filename);
        message.appendChild(toggle);
      }
    }

    async function pasteFromClipboard() {
      if (urlInput.value) {
        urlInput.value = '';
        updatePasteButton(pasteButton, urlInput);
        urlInput.focus();
        return;
      }

      try {
        urlInput.value = await navigator.clipboard.readText();
        updatePasteButton(pasteButton, urlInput);
        setMessage(_t('download.pasted'));
      } catch (error) {
        setMessage(_t('download.clipboard-error'), 'error');
      }
    }

    async function downloadVideo(event) {
      event.preventDefault();
      var videoUrl = urlInput.value.trim();
      var format = formatInput ? formatInput.value : 'best';

      if (!videoUrl) {
        setMessage(_t('download.url-required'), 'error');
        urlInput.focus();
        return;
      }

      showProcessing();

      try {
        var params = new URLSearchParams({ url: videoUrl, format: format });
        var response = await fetch('/api/download?' + params.toString());

        if (!response.ok) {
          var body = await response.json().catch(function () { return {}; });
          var retryAfter = response.headers.get('Retry-After');
          var suffix = retryAfter ? ' ' + _t('download.retry-after', { seconds: retryAfter }) : '';
          throw new Error((body.error || body.details || response.statusText) + '.' + suffix);
        }

        var blob = await response.blob();
        pendingBlob = blob;
        pendingFilename = filenameFromDisposition(response.headers.get('Content-Disposition'), response.headers.get('Content-Type'));
        urlInput.value = '';
        updatePasteButton(pasteButton, urlInput);
        showDownloadReady();
      } catch (error) {
        cancelProcessing();
        setMessage(_t('download.error') + ': ' + error.message, 'error');
      }
    }

    if (pasteButton) pasteButton.addEventListener('click', pasteFromClipboard);
    form.addEventListener('submit', downloadVideo);
    if (downloadTrigger) downloadTrigger.addEventListener('click', triggerDownload);
  });

  document.addEventListener('localechange', function () {
    _t = window.i18n ? window.i18n.t : function (k) { return k; };
    if (btnInstall) {
      btnInstall.textContent = _t('install.btn');
    }
    document.querySelectorAll('[data-download-form]').forEach(function (form) {
      var input = form.querySelector('[name="url"]');
      var pasteBtn = form.querySelector('[data-paste]');
      var submitBtn = form.querySelector('[type="submit"]');
      var progressLabel = form.closest('[data-download-card]') && form.closest('[data-download-card]').querySelector('[data-progress-label]');
      updatePasteButton(pasteBtn, input);
      if (submitBtn && !submitBtn.disabled) {
        submitBtn.textContent = _t('download.submit');
      }
      if (progressLabel) {
        progressLabel.textContent = _t('download.processing');
      }
    });
  });
})();
