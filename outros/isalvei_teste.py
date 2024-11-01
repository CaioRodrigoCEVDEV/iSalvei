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
API_KEY = 'AIzaSyCRsGFR5tM0FbBHlDWe4lQjn2udsMt1yj4'
class RequestHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/download/'):
            # Extrair a URL do vídeo diretamente da rota
            video_url = urllib.parse.unquote(self.path[len('/download/'):])

            ydl_opts = {
                'format': 'bestvideo[ext=mp4]',
                'outtmpl': '%(title).10s.%(ext)s',
                'format': 'best',
                'quiet': True,
                'noplaylist': True,
                'username': 'oauth',
                'password': '',
                'cookiefile': '/var/www/html/isalvei/ytt_cookies.txt',
                #'max_duration': '60m',
                #'cookiesfrombrowser': ('chrome',),
                'api_key': API_KEY
            }

            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(video_url, download=True)
                    file_path = ydl.prepare_filename(info)

                file_url = os.path.abspath(file_path)
                base_url = 'http://89.117.33.245'
                file_url.replace('/var/www/html', base_url).replace(':8000', '')
                file_url = file_url.replace('/var/www/html', base_url).replace(':8000', '').replace('#', '%')

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
