function abrirLink() {
        var link = document.getElementById('yt_dlp').value;        
        if (link) {
          if (link.includes("youtube.com")||link.includes(("youtu.be"))) {
              var encodedLink = encodeURIComponent(link);
               
             // window.open('http://127.0.0.1:8000/download/'+ encodedLink, '_blank');

          } else {
              alert("Por favor, insira um link válido do YouTube.");
          }             
        } else {
            alert("O campo de link está vazio.");
        }
    }