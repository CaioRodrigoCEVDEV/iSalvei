from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import yt_dlp
import uvicorn

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ou uma lista específica de URLs, por exemplo, ["https://seusite.com"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ler chaves de API de arquivos
with open('/etc/api_key.txt', 'r') as y:
    API_KEY = y.read().strip()
with open('/etc/api_key_i.txt', 'r') as i:
    API_KEY_I = i.read().strip()
with open('/etc/api_key_x.txt','r') as x:
    API_KEY_X = x.read().strip()
with open('/etc/api_key_x_secret.txt','r') as x_secret:
    API_KEY_X_SECRET = x_secret.read().strip()
with open('/etc/api_key_x_token.txt','r') as x_token:
    API_KEY_X_TOKEN = x_token.read().strip()
with open('/etc/api_key_x_token_secret.txt','r') as x_token_secret:
    API_KEY_X_TOKEN_SECRET = x_token_secret.read().strip()

class VideoRequest(BaseModel):
    url: str

@app.post("/download")
async def download_video(request: VideoRequest):
    url = request.url
    ydl_opts = {}

    # Configurar opções baseadas no domínio
    if 'instagram.com' in url or 'facebook.com' in url:
        ydl_opts = {
            'format': 'best[ext=mp4]/best',
            'outtmpl': '/var/www/html/download/%(id)s.%(ext)s',
            'api_key': API_KEY_I,
            'sleep_interval': 5,
            'max_sleep_interval': 10,
        }
    elif 'youtube.com' in url or 'youtu.be' in url:
        ydl_opts = {
            'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]',
            'outtmpl': '/var/www/html/download/%(id)s.%(ext)s',
            'quiet': True,
            'noplaylist': True,
            'cookiefile': '/var/www/isalvei/cookiesYT.txt',
            'sleep_interval': 5,
            'max_sleep_interval': 15,
            'api_key': API_KEY,
        }
    elif 'x.com' in url or 'twitter.com' in url:
        ydl_opts = {
            'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]',
            'outtmpl': '/var/www/html/download/%(id)s.%(ext)s',
            'sleep_interval': 5,
            'max_sleep_interval': 15,
            'twitter_api': {
                'app_key': API_KEY_X,
                'app_secret': API_KEY_X_SECRET,
                'oauth_token': API_KEY_X_TOKEN,
                'oauth_token_secret': API_KEY_X_TOKEN_SECRET,
            },
        }

    # Realizar o download
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=True)
            result = {
                'status': 'success',
                'id': info_dict.get('id'),
                'title': info_dict.get('title'),
                'url': info_dict.get('url'),
                'duration': info_dict.get('duration'),
            }
            return result
    except Exception as e:
        return {
            'status': 'error',
            'message': str(e),
            'url': url,
        }

if __name__ == '__main__':
    # Usando os parâmetros ssl_keyfile e ssl_certfile diretamente
    uvicorn.run("isalveiFlaskAPI:app", host="0.0.0.0", port=5000, 
                ssl_keyfile="/etc/ssl/private/private.key", ssl_certfile="/etc/ssl/certificate.crt")
