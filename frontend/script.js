(function () {
  let deferredPrompt = null;
  const installBtn = document.getElementById('installBtn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      if (result.outcome === 'accepted') installBtn.hidden = true;
      deferredPrompt = null;
    });
  }

  window.addEventListener('appinstalled', () => {
    if (installBtn) installBtn.hidden = true;
    deferredPrompt = null;
  });

  function filenameFromDisposition(disposition, contentType) {
    const utf = disposition && disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const ascii = disposition && disposition.match(/filename="?([^";]+)"?/i);
    if (utf) return decodeURIComponent(utf[1]);
    if (ascii) return ascii[1];
    const ext = (contentType || 'video/mp4').split('/').pop().split(';')[0] || 'mp4';
    return `isalvei-video.${ext}`;
  }

  document.querySelectorAll('[data-download-form]').forEach(form => {
    const urlInput = form.querySelector('[name="url"]');
    const formatInput = form.querySelector('[name="format"]');
    const pasteButton = form.querySelector('[data-paste]');
    const submitButton = form.querySelector('[type="submit"]');
    const card = form.closest('[data-download-card]') || form.parentElement;
    const message = card.querySelector('[data-message]');

    function setMessage(text, type) {
      if (!message) return;
      message.textContent = text || '';
      message.classList.remove('error', 'success');
      if (type) message.classList.add(type);
    }

    function setLoading(isLoading) {
      submitButton.disabled = isLoading;
      submitButton.textContent = isLoading ? 'Preparando...' : 'Baixar agora';
    }

    async function pasteFromClipboard() {
      if (urlInput.value) {
        urlInput.value = '';
        pasteButton.textContent = 'Colar link';
        urlInput.focus();
        return;
      }

      try {
        urlInput.value = await navigator.clipboard.readText();
        pasteButton.textContent = 'Limpar';
        setMessage('Link colado. Confira a URL e clique em baixar.');
      } catch (error) {
        setMessage('Não foi possível acessar a área de transferência. Cole manualmente.', 'error');
      }
    }

    async function downloadVideo(event) {
      event.preventDefault();
      const videoUrl = urlInput.value.trim();
      const format = formatInput ? formatInput.value : 'best';

      if (!videoUrl) {
        setMessage('Cole uma URL pública antes de baixar.', 'error');
        urlInput.focus();
        return;
      }

      setLoading(true);
      setMessage('Validando link e preparando o arquivo. Isso pode levar alguns instantes...');

      try {
        const params = new URLSearchParams({ url: videoUrl, format });
        const response = await fetch(`/api/download?${params.toString()}`);

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const retryAfter = response.headers.get('Retry-After');
          const suffix = retryAfter ? ` Tente novamente em ${retryAfter}s.` : '';
          throw new Error(`${body.error || body.details || response.statusText}.${suffix}`);
        }

        const blob = await response.blob();
        const filename = filenameFromDisposition(response.headers.get('Content-Disposition'), response.headers.get('Content-Type'));
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(blobUrl);
        setMessage(`Download iniciado: ${filename}`, 'success');
        urlInput.value = '';
        if (pasteButton) pasteButton.textContent = 'Colar link';
      } catch (error) {
        setMessage(`Erro: ${error.message}`, 'error');
      } finally {
        setLoading(false);
      }
    }

    if (pasteButton) pasteButton.addEventListener('click', pasteFromClipboard);
    form.addEventListener('submit', downloadVideo);
  });
})();
