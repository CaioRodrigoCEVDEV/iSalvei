function abrirLinkX() {
    var link = document.getElementById('yt_dlp').value;
    
    if (link) {
      if (link.includes("x.com")) {  
          var encodedLink = encodeURIComponent(link);
          //window.open('http://127.0.0.1:8000/download/'+ encodedLink, '_blank');
          document.getElementById('downloadFrame').style.display = 'block';
          document.getElementById('downloadFrame').src = 'http://127.0.0.1:8000/download/' + encodedLink;
      } else {
          alert("Por favor, insira um link válido.");
      }
        
    } else {
        alert("O campo de link está vazio.");
    }
}
