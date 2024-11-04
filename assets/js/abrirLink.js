function abrirLink() {
        var link = document.getElementById('yt_dlp').value;        
        if (link) {
          if (link.includes("youtube.com")||link.includes(("youtu.be"))) {
              var encodedLink = encodeURIComponent(link);
               //window.open('http://89.117.33.245:8000/download/'+ encodedLink, '_blank');
               document.getElementById('downloadFrame').style.display = 'block';
               document.getElementById('downloadFrame').src = 'http://89.117.33.245:8000/download/' + encodedLink;
          } else {
              alert("Por favor, insira um link válido do YouTube.");
          }             
        } else {
            alert("O campo de link está vazio.");
        }
    }