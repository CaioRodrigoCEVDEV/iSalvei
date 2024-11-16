function extrairID() {
    var url = document.getElementById("yt_dlp").value;
    var id = "";

    // Regex para URL padrão do YouTube
    var regexYouTube = /(?:https?:\/\/(?:www\.)?youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|.*[?&]v%3D))([^"&?\/\s]{11})/;
    var matchYouTube = url.match(regexYouTube);

    if (matchYouTube) {
        id = matchYouTube[1];
    } else {
        // Regex para URL curta (youtu.be)
        var regexShortYouTube = /(?:https?:\/\/(?:www\.)?youtu\.be\/)([^"&?\/\s]{11})/;
        var matchShortYouTube = url.match(regexShortYouTube);

        if (matchShortYouTube) {
            id = matchShortYouTube[1];
        } else {
            // Regex para URL do YouTube Shorts
            var regexShortsYouTube = /(?:https?:\/\/(?:www\.)?youtube\.com\/shorts\/)([^"&?\/\s]{11})/;
            var matchShortsYouTube = url.match(regexShortsYouTube);

            if (matchShortsYouTube) {
                id = matchShortsYouTube[1];
            } else {
                // Regex para URL do Facebook
                var regexFacebook = /(?:https?:\/\/(?:www\.)?facebook\.com\/share\/r\/)([^"&?\/\s]+)/;
                var matchFacebook = url.match(regexFacebook);

                if (matchFacebook) {
                    id = matchFacebook[1];
                } else {
                    // Regex para URL do X (antigo Twitter)
                    var regexX = /(?:https?:\/\/(?:www\.)?x\.com\/[^\/]+\/status\/)(\d+)/;
                    var matchX = url.match(regexX);

                    if (matchX) {
                        id = matchX[1];
                    } else {
                        // Regex para URL do Instagram
                        var regexInstagram = /(?:https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/)([^"&?\/\s]+)/;
                        var matchInstagram = url.match(regexInstagram);

                        if (matchInstagram) {
                            id = matchInstagram[1];
                        }
                    }
                }
            }
        }
    }

    // Exibe o ID ou uma mensagem de erro
    if (id) {
        document.getElementById("resultado").innerText = "ID do Link: " + id;
    } else {
        document.getElementById("resultado").innerText = "URL inválida. Tente outra.";
    }
}