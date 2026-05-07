# iSalvei

**iSalvei** é uma aplicação web que permite o download de vídeos públicos de diversas plataformas compatíveis com `yt-dlp`.
Com interface moderna, rate limit por IP e proteção contra URLs internas, o usuário cola o link desejado e realiza o download diretamente pelo navegador.

## 🚀 Demonstração

Para utilizar o iSalvei, basta acessar o arquivo `index.html` presente no repositório e abrir em seu navegador.

## 🧠 Funcionalidades

- Download de vídeos públicos de X/Twitter, Instagram, YouTube e outras fontes suportadas pelo `yt-dlp`.
- Rate limit configurável por IP (`RATE_LIMIT_MAX` e `RATE_LIMIT_WINDOW_MS`).
- Interface moderna com páginas de início, download e plataformas.
- Proteção contra protocolos não HTTP(S), localhost e faixas privadas de IP.

## 🛠️ Tecnologias Utilizadas

- HTML
- CSS
- JavaScript
- Node.js / Express
- yt-dlp e ffmpeg no servidor

## 📦 Instalação

1. Clone o repositório:
   ```bash
   git clone https://github.com/CaioRodrigoCEVDEV/iSalvei.git

   sudo apt install -y python3 python3-pip python-is-python3 build-essential
   sudo apt install -y yt-dlp
   sudo apt install -y ffmpeg

   npm install

   npm start

   ```

2. Acesse o diretório do projeto:
   ```bash
   cd iSalvei
   ```

3. Abra o arquivo `index.html` em seu navegador preferido.

## 📫 Contato

Desenvolvedor: [Caio Rodrigo](https://github.com/CaioRodrigoCEVDEV)
E-mail: [contato@caiorodrigocev.com.br](mailto:contato@caiorodrigocev.com.br)

---

Sinta-se à vontade para contribuir com melhorias ou relatar problemas através da [aba de Issues](https://github.com/CaioRodrigoCEVDEV/iSalvei/issues).