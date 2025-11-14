
/* Integration script added by assistant.
   It attempts to wire input with id or name containing 'url' and buttons containing 'download'/'salvar' text.
   If your HTML uses different IDs, please tell me and I will adapt exactly.
*/
(function(){
  function qs(sel){return document.querySelector(sel);}
  // find input that likely contains the URL
  var urlInput = qs('input[type="text"][placeholder], input[name*="url"], input[id*="url"]') || qs('input');
  var downloadBtn = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]'))
    .find(el=>/(baixar|salvar|download|downloadar|save)/i.test(el.textContent || el.value || ""));
  var previewBtn = null;
  if(!downloadBtn) downloadBtn = qs('button') || null;

  function getApiKey(){
    return localStorage.getItem('apiKey') || '';
  }

  function setMsg(msg, err){
    var el = qs('#msg') || qs('.msg') || null;
    if(el){ el.textContent = msg; el.style.color = err?'#b91c1c':'#111'; }
    else console.log(msg);
  }

  async function download(url){
    if(!url) return setMsg('Cole a URL antes de baixar', true);
    setMsg('Processando...');
    try{
      var headers = {};
      var key = getApiKey();
      if(key) headers['X-API-KEY'] = key;
      var resp = await fetch('/api/download?url='+encodeURIComponent(url), { headers: headers });
      if(!resp.ok){
        var j = await resp.json().catch(()=>null);
        setMsg('Erro: '+(j?.error||resp.statusText), true);
        return;
      }
      var blob = await resp.blob();
      var cd = resp.headers.get('Content-Disposition')||'';
      var m = cd.match(/filename="(.+?)"/);
      var filename = m?m[1]:'video.mp4';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setMsg('Download concluído: '+filename);
    }catch(e){ console.error(e); setMsg('Erro: '+e.message, true); }
  }

  if(downloadBtn && urlInput){
    downloadBtn.addEventListener('click', function(e){
      e.preventDefault();
      download(urlInput.value.trim());
    });
  }

})();
