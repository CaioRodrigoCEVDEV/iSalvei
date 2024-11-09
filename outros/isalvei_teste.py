import yt_dlp
import os
from http.server import SimpleHTTPRequestHandler, HTTPServer
import urllib.parse

HTML_FORM = '''
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YouTube Video Downloader</title>
    <style>
        div.classImagem{
            text-align: center;
        }
        div.inputUrl{
            text-align: center;
        }
    </style>
</head>
<body>
   
</body>
</html>
'''
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

class RequestHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/download/'):
            # Extrair a URL do vídeo diretamente da rota
            video_url = urllib.parse.unquote(self.path[len('/download/'):])
            ydl_opts = {}
            if 'instagram.com' in video_url or 'facebook.com' in video_url:
                ydl_opts = {
                'format':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]',
                'outtmpl': '/var/www/html/download/%(id)s.%(ext)s',
                'format': 'best',                    
                'api_key': API_KEY_I,
                'sleep_interval': 5,
                'max_sleep_interval': 15
                }
            elif 'youtube.com' in video_url or 'youtu.be' in video_url:
                    ydl_opts = {
                        'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]',
                        'outtmpl': '/var/www/html/download/%(id)s.%(ext)s',
                        'format': 'best',
                        'quiet': True,
                        'noplaylist': True,
                        'username': 'oauth',
                        'password': '',
                        'cookiefile': '/var/www/isalvei/ytt_cookies.txt',
                        #'max_duration': '60m',
                        #'cookiesfrombrowser': ('chrome',),
                        'sleep_interval': 5,
                        'max_sleep_interval': 15,
                        'api_key': API_KEY
                    }
                 
            elif 'x.com' in video_url or 'twitter.com' in video_url:
                  ydl_opts = {
                    'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]',
                    'outtmpl': '/var/www/html/download/%(id)s.%(ext)s',
                    'sleep_interval': 5,
                    'max_sleep_interval': 15,
                    'twitter_api': {
                        'app_key': API_KEY_X,
                        'app_secret':API_KEY_X_SECRET,
                        'oauth_token': API_KEY_X_TOKEN,
                        'oauth_token_secret': API_KEY_X_TOKEN_SECRET
                     }
                   }

            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(video_url, download=True)
                    file_path = ydl.prepare_filename(info)

                file_url = os.path.abspath(file_path)
                base_url = 'http://127.0.0.1'
                file_url.replace('/var/www/html', base_url)
                file_url = file_url.replace('/var/www/html', base_url).replace('#', '%23').replace(' ','%20')
                response_html = f'''<script>window.location.href = '{file_url}';</script>
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Download concluído</title>
                </head>
                <body>
                </body>
                </html>
                '''
                self.send_response(200)
                self.send_header('Content-type', 'text/html')
                self.end_headers()
                self.wfile.write(response_html.encode('utf-8'))

            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'text/html')
                self.end_headers()
                self.wfile.write(f'<h1>Erro ao baixar o vídeo: {str(e)}</h1>'.encode('utf-8'))

        elif self.path == '/':
             self.send_response(200)
             self.send_header('Content-type', 'text/html')
             self.end_headers()
             self.wfile.write(HTML_FORM.encode('utf-8'))
        else:
            self.send_error(404, "File not found")

def run(server_class=HTTPServer, handler_class=RequestHandler, port=8000):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f'Starting httpd server on port {port}')
    httpd.serve_forever()

if __name__ == "__main__":
    run()

