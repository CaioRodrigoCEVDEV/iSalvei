function abrirLink() {
        var link = document.getElementById('yt_dlp').value;        
        if (link) {
          if (link.includes("youtube.com")||link.includes(("youtu.be"))) {
              var encodedLink = encodeURIComponent(link);
              
              //window.open('http://127.0.0.1:8000/download/'+ encodedLink, '_blank');

               // Descomentar os dois abaixo para abrir o video na mesma tela abaixo do botao baixar
               
<<<<<<< HEAD
               document.getElementById('downloadFrame').style.display = 'block';
               document.getElementById('downloadFrame').src = 'http://127.0.0.1:8000/download/' + encodedLink;
=======
               //document.getElementById('downloadFrame').style.display = 'block';
               //document.getElementById('downloadFrame').src = 'https://89.117.33.245:8000/download/' + encodedLink;
>>>>>>> self_page
          } else {
              alert("Por favor, insira um link válido do YouTube.");
          }             
        } else {
            alert("O campo de link está vazio.");
        }
    }