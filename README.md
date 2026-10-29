# iSalvei

**iSalvei** é uma aplicação web para baixar vídeos públicos das plataformas suportadas pelo backend (YouTube, Instagram, TikTok, Facebook e X/Twitter).
Com interface moderna, rate limit por IP e proteção contra URLs internas, o usuário cola o link desejado e realiza o download diretamente pelo navegador.

## 🚀 Demonstração

Inicie o backend com `npm start` e acesse `http://localhost:3000` no navegador. O frontend depende da API para validar e baixar os vídeos.

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
| Instagram | Reels e posts públicos | Impersonation (`curl-cffi`) + login assistido no app para conteúdo restrito |
| TikTok | Vídeos e links `vm/vt.tiktok.com` | Pode exigir impersonation (`curl-cffi`) |
| Facebook | Vídeos, Reels e `fb.watch` | Conteúdo privado exige autenticação |
| X/Twitter | Posts com vídeo | Depende do extractor do yt-dlp |
| Kwai | **Não suportado** | O yt-dlp não possui extractor de Kwai; retorna 422 |

- **Melhor qualidade**: até 1080p, H.264/AAC, priorizando compatibilidade.
- **720p/480p**: limitados pelo menor lado do vídeo. Um Reel 720x1280 continua 720x1280 em 720p.
- **Áudio**: extraído para `.m4a` (AAC).
- Vídeos acima de `MAX_VIDEO_DURATION` ou `MAX_FILE_SIZE` são recusados.
- Para YouTube/TikTok completos, instale `yt-dlp[default,curl-cffi]` (Docker, venv ou pipx). Pacotes `apt`/standalone antigos podem não ter o runtime EJS nem impersonation.
- Conteúdo privado, removido, com DRM, ao vivo ou sem vídeo retorna erro claro e não é repetido indefinidamente.

### Instagram: Reels públicos e conta conectada

O Instagram passou a bloquear requisições anônimas sem fingerprint de navegador.
O backend envia `--impersonate chrome` para o yt-dlp; com `curl-cffi` instalado
(a imagem Docker e a instalação recomendada já incluem), Reels públicos baixam
sem login.

Se o conteúdo continuar exigindo autenticação, o app mostra o botão
**Conectar conta** (ou abre o diálogo automaticamente após um erro
`AUTH_REQUIRED`). O diálogo abre a **tela real de login do Instagram** em um
Chromium headless no servidor. O usuário digita usuário, senha e 2FA
normalmente, como no navegador, e o backend captura apenas os cookies
resultantes. A senha transita pela sessão do navegador durante o login, mas não
é lida pela aplicação, armazenada ou registrada em logs. A sessão:

- fica somente na memória do servidor (não vai para o banco nem para logs);
- é usada apenas em downloads do Instagram;
- expira automaticamente (`IG_SESSION_TTL`, padrão 12 horas) e pode ser
  desconectada a qualquer momento.

Para quem preferir, o diálogo tem a opção avançada **“Prefiro colar os cookies
manualmente”**, que aceita `sessionid` ou um `cookies.txt` exportado.

Requisitos do login assistido: `playwright-core` (dependência npm) e
Chromium/Chrome instalado. A imagem Docker já inclui Chromium; em instalação
manual, configure `IG_BROWSER_PATH` se o binário não estiver em um caminho
padrão. Desafios de segurança (2FA, captcha, confirmação por e-mail) aparecem na
própria janela e podem ser concluídos normalmente; se o Instagram bloquear o
navegador do servidor, resta a opção manual de cookies.

Como a sessão vive em memória, reinícios do processo desconectam a conta e
implantação com múltiplas instâncias exige sticky sessions (ou um store
compartilhado).

O uso de uma conta é opcional e por conta e risco do usuário: o Instagram pode
sinalizar contas usadas em automação. Use HTTPS em produção e respeite os termos
da plataforma e o direito de salvar cada conteúdo.

### Cookies globais (fallback do servidor)

Para uma conta de serviço compartilhada, ainda é possível montar um arquivo
Netscape `cookies.txt` fora do repositório:

```bash
COOKIES_FILE=/run/secrets/cookies.txt
```

Cookies do usuário têm precedência sobre esse arquivo. Nunca versione o arquivo
e saiba que cookies não são registrados nos logs.


## 🛠️ Tecnologias Utilizadas

- HTML
- CSS
- JavaScript
- Node.js / Express
- yt-dlp e ffmpeg no servidor
- Playwright + Chromium para o login assistido do Instagram

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
   export YTDLP_PATH="$PWD/.venv-ytdlp/bin/yt-dlp"

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

Os testes reais cobrem YouTube, Instagram, TikTok, Facebook, X/Twitter e a rejeição de Kwai.
Conteúdo privado depende de cookies/amostras válidas e pode ser marcado como pendente no relatório de execução.

## 📫 Contato

Desenvolvedor: [Caio Rodrigo](https://github.com/CaioRodrigoCEVDEV)
E-mail: [contato@caiorodrigocev.com.br](mailto:contato@caiorodrigocev.com.br)

---

Sinta-se à vontade para contribuir com melhorias ou relatar problemas através da [aba de Issues](https://github.com/CaioRodrigoCEVDEV/iSalvei/issues).