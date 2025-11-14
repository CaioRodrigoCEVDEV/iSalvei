function abrirLinkInsta() {
    var link = document.getElementById('yt_dlp').value;
    
    if (link) {
      if (link.includes("instagram.com")) {  
          var encodedLink = encodeURIComponent(link);
               
              window.open('http://89.117.33.245:8000/download/'+ encodedLink, '_blank');

               // Descomentar os dois abaixo para abrir o video na mesma tela abaixo do botao baixar
               
               //document.getElementById('downloadFrame').style.display = 'block';
               //document.getElementById('downloadFrame').src = 'http://89.117.33.245:8000/download/' + encodedLink;
      } else {
          alert("Por favor, insira um link válido.");
      }
        
    } else {
        alert("O campo de link está vazio.");
    }
}
