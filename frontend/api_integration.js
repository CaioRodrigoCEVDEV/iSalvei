
// api_integration.js
(function(){
  function qs(sel){return document.querySelector(sel);}
  function getApiKey(){ return localStorage.getItem('apiKey') || ''; }
  function setMsg(msg, isError){ var el = qs('#msg') || document.getElementById('msg'); if(el){ el.textContent = msg; el.style.color = isError? '#b91c1c':'#111'; } else console.log(msg); }

  async function doDownload(url){
    if(!url) return setMsg('Cole a URL antes de baixar', true);
    setMsg('Processando...');
    try{
      const headers = {};
      const key = getApiKey();
      if(key) headers['X-API-KEY'] = key;
      const resp = await fetch('/api/download?url=' + encodeURIComponent(url), { headers });
      if(!resp.ok){
        const j = await resp.json().catch(()=>null);
        setMsg('Erro: ' + (j?.error || resp.statusText), true);
        return;
      }
      const blob = await resp.blob();
      const cd = resp.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="(.+?)"/);
      const filename = m ? m[1] : 'video.mp4';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setMsg('Download concluído: ' + filename);
    }catch(e){
      console.error(e);
      setMsg('Erro no download: ' + e.message, true);
    }
  }

  // wire common elements
  document.addEventListener('click', function(e){
    var el = e.target;
    if(el && (el.id === 'downloadBtn' || /baixar|download/i.test(el.textContent || ''))){
      e.preventDefault();
      var urlEl = qs('#url') || qs('input[name="url"]') || qs('input[type="text"]');
      if(urlEl) doDownload(urlEl.value.trim());
    }
  });

  // form submit fallback
  document.addEventListener('submit', function(e){
    var form = e.target;
    if(form && (form.id === 'dlForm' || qs('#url'))){
      e.preventDefault();
      var urlEl = qs('#url') || qs('input[name="url"]') || qs('input[type="text"]');
      if(urlEl) doDownload(urlEl.value.trim());
    }
  });

})();
