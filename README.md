# iSalvei

**iSalvei** é uma aplicação web que permite o download de vídeos públicos de diversas plataformas compatíveis com `yt-dlp`.
Com interface moderna, rate limit por IP e proteção contra URLs internas, o usuário cola o link desejado e realiza o download diretamente pelo navegador.

## 🚀 Demonstração

Para utilizar o iSalvei, basta acessar o arquivo `index.html` presente no repositório e abrir em seu navegador.

## 🧠 Funcionalidades

- Download de vídeos públicos de **YouTube, Instagram, TikTok, Facebook e X/Twitter**.
- Formatos: melhor qualidade (até 1080p), 720p, 480p e somente áudio (`.m4a`).
- Saída H.264/AAC em MP4 para compatibilidade com celulares, WhatsApp e navegadores.
- Suporte a links convencionais e curtos (`youtu.be`, `instagr.am`, `vm.tiktok.com`, `fb.watch`).
- Rate limit configurável por IP (`RATE_LIMIT_MAX` e `RATE_LIMIT_WINDOW_MS`).
- Limite de concorrência configurável (`MAX_CONCURRENT_DOWNLOADS`).
- Interface moderna com páginas de início, download e plataformas.
- Proteção contra protocolos não HTTP(S), localhost, faixas privadas de IP, DNS interno e redirects para fora da allowlist.

### Plataformas e qualidade

| Plataforma | Suporte | Observação |
|---|---|---|
| YouTube | Vídeos, Shorts, `youtu.be`, ao vivo não | Requer Node 22+ ou Deno para o runtime JS do yt-dlp. Em IPs de datacenter pode exigir cookies/PO token |
| Instagram | Reels e posts públicos | Conteúdo privado/login exige `COOKIES_FILE` |
| TikTok | Vídeos e links `vm/vt.tiktok.com` | Pode exigir impersonation (`curl-cffi`) |
| Facebook | Vídeos, Reels e `fb.watch` | Conteúdo privado exige autenticação |
| X/Twitter | Posts com vídeo | Depende do extractor do yt-dlp |
| Kwai | **Não suportado** | O yt-dlp não possui extractor de Kwai; retorna 422 |

- **Melhor qualidade**: até 1080p, H.264/AAC, priorizando compatibilidade.
- **720p/480p**: limitados pelo menor lado do vídeo. Um Reel 720x1280 continua 720x1280 em 720p.
- **Áudio**: extraído para `.m4a` (AAC).
- Vídeos acima de `MAX_VIDEO_DURATION` ou `MAX_FILE_SIZE` são recusados.
- Conteúdo privado, removido, com DRM, ao vivo ou sem vídeo retorna erro claro e não é repetido indefinidamente.

### Cookies (conteúdo restrito)

O Instagram e o Facebook podem exigir login. Monte um arquivo Netscape `cookies.txt` fora do repositório e configure:

```bash
COOKIES_FILE=/run/secrets/cookies.txt
```

Nunca versione esse arquivo. Os cookies não são registrados nos logs.


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

   # Requisitos: Node.js >= 22, yt-dlp, ffmpeg e ffprobe
   sudo apt install -y python3 python3-pip python3-venv python-is-python3 build-essential
   sudo apt install -y ffmpeg
   # Instale o yt-dlp com runtime JS e impersonation; veja docs/DEPLOY.md
   python3 -m venv .venv-ytdlp
   .venv-ytdlp/bin/pip install "yt-dlp[default,curl-cffi]==2026.10.26"

   npm ci --omit=dev

   npm start

   ```

2. Acesse o diretório do projeto:
   ```bash
   cd iSalvei
   ```

3. Abra o arquivo `index.html` em seu navegador preferido.

## 🚀 Deploy em produção

O deploy automatizado está em `scripts/deploy.sh` e a documentação completa em
[`docs/DEPLOY.md`](docs/DEPLOY.md).

```bash
# Simulação (não altera nada)
./scripts/deploy.sh --dry-run

# Deploy completo (código + dependências + yt-dlp + restart + health checks)
./scripts/deploy.sh

# Atualizar somente o yt-dlp ou somente o código
./scripts/deploy.sh --yt-dlp-only
./scripts/deploy.sh --code-only

# Fixar a versão do yt-dlp
./scripts/deploy.sh --yt-dlp-version 2026.10.26
```

O script detecta Docker, systemd, PM2 ou processo Node direto. Se a detecção
automática não for possível, informe o método com `--method` e a configuração
correspondente (veja a documentação). Backups, logs e relatórios ficam em
`.deploy/`.

## 🧪 Testes

```bash
# Testes automatizados (sem rede): URLs, SSRF, plataformas, erros, limites,
# transcodificação, rotas e limpeza de temporários.
npm run test:download

# Testes reais com conteúdos públicos. Exige yt-dlp 2026.10.26+ e rede.
YTDLP_PATH=/caminho/para/yt-dlp npm run test:live
```

Os testes reais cobrem YouTube, Instagram, TikTok, Facebook e a rejeição de Kwai.
Conteúdo privado e X/Twitter dependem de amostras válidas/cookies e podem ser
marcados como pendentes no relatório de execução.

## 📫 Contato

Desenvolvedor: [Caio Rodrigo](https://github.com/CaioRodrigoCEVDEV)
E-mail: [contato@caiorodrigocev.com.br](mailto:contato@caiorodrigocev.com.br)

---

Sinta-se à vontade para contribuir com melhorias ou relatar problemas através da [aba de Issues](https://github.com/CaioRodrigoCEVDEV/iSalvei/issues).