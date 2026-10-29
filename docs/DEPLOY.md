# Deploy do iSalvei

Este documento descreve o deploy automatizado em `scripts/deploy.sh`, incluindo
atualização controlada do `yt-dlp`, health checks, rollback e limitações do
ambiente de produção.

> **Importante:** o repositório não contém uma unidade systemd, um ecossistema
> PM2 nem um `docker-compose.yml`. Por isso o script **detecta** o mecanismo em
> execução e também permite informá-lo explicitamente. O ambiente usado para
> desenvolver este script era de desenvolvimento, não produção. Revise a seção
> [O que depende do ambiente de produção](#o-que-depende-do-ambiente-de-produção)
> antes do primeiro deploy.

## 1. Arquitetura encontrada

- Aplicação Node.js/Express. O `package.json` atual exige **Node.js >= 22**.
- Entrada principal: `server.js` (`npm start`, `package.json > main`).
- Processo opcional de API: `api_server.js` (`npm run start:api`), com banco
  SQLite em `API_DB_PATH` (padrão `./data/api.db`).
- Frontend estático em `frontend/`; não há etapa de build de frontend.
- Health check HTTP existente: `GET /health` em `server.js` e em
  `api_server.js` (adicionado neste trabalho).
- `yt-dlp` é invocado por `child_process.spawn` usando `YTDLP_PATH`
  (padrão `yt-dlp`, resolvido pelo `PATH` do processo do backend). O módulo
  `lib/downloader.js` também usa `FFMPEG_PATH`/`FFPROBE_PATH`.
- `FFmpeg` é invocado usando `FFMPEG_PATH` (padrão `ffmpeg`) e `ffprobe`
  usando `FFPROBE_PATH` (padrão `ffprobe`).
- `youtube-dl-exec` existe no `package.json`, mas o backend atual não o usa.
- O `Dockerfile` usa `node:22-bookworm-slim`, instala o `yt-dlp` em um
  virtualenv e executa `node server.js`; não há Compose no repositório.
- Dados persistentes: `.env`, banco SQLite em `data/` (`API_DB_PATH`),
  eventual `COOKIES_FILE` e diretórios temporários (`TMP_DIR` ou `/tmp`).
- Branch de produção: `main` (configurável por `DEPLOY_BRANCH`).
- O diretório real da aplicação **não é presumido**: por padrão é o diretório
  pai de `scripts/`, e pode ser sobrescrito com `APP_DIR`.

### `server.js` ou `api_server.js`?

O deploy padrão reinicia apenas `server.js`. Se a produção também executa a API
separada, use `--process api` ou `--process both` e configure
`DEPLOY_SYSTEMD_SERVICES`/`DEPLOY_PM2_APPS` quando a detecção automática não for
suficiente. No modo Docker o `Dockerfile` do repositório inicia apenas
`server.js`.

## 2. Uso rápido

Execute como o usuário dono da aplicação (não como root, se possível):

```bash
cd /caminho/do/iSalvei

# Simulação: não altera código, dependências, yt-dlp nem serviços
./scripts/deploy.sh --dry-run

# Deploy completo (código + npm ci + yt-dlp + restart + health checks)
./scripts/deploy.sh

# Atualizar somente o código
./scripts/deploy.sh --code-only

# Atualizar somente o yt-dlp
./scripts/deploy.sh --yt-dlp-only

# Fixar a versão do yt-dlp
./scripts/deploy.sh --yt-dlp-version 2026.03.17
```

Também é possível usar `npm run deploy` e `npm run deploy:dry-run`.

O script retorna código diferente de zero em qualquer falha, inclusive quando o
rollback é executado com sucesso (o deploy continua sendo uma falha).

## 3. Modos de operação

| Modo | Código | `npm ci` | `yt-dlp` | Restart |
|---|---|---|---|---|
| padrão | atualiza | sim | atualiza | sim (exceto Docker: recria) |
| `--code-only` | atualiza | sim | mantém | sim (exceto Docker: recria) |
| `--yt-dlp-only` | mantém | não | atualiza | não fora do Docker; sim no Docker |

`--code-only` e `--yt-dlp-only` são mutuamente exclusivos.

### `--dry-run`

Faz somente leitura: mostra método detectado, versão atual/alvo do `yt-dlp`,
método de instalação, comandos que seriam executados, backup e URLs de health.
Não cria `.deploy`, não executa `git fetch/merge`, não roda `npm ci`, não altera
o `yt-dlp` e não reinicia serviços. A resolução da versão mais recente e as
verificações de rede podem ser feitas em modo somente leitura; se a rede falhar,
o dry-run avisa e continua.

## 4. Detecção do mecanismo e configuração

O script tenta, nesta ordem: Docker, systemd, PM2 e processo Node direto.
Se nada for encontrado, falha com instruções em vez de adivinhar.

Para forçar o mecanismo:

```bash
./scripts/deploy.sh --method systemd
./scripts/deploy.sh --method pm2
./scripts/deploy.sh --method docker
./scripts/deploy.sh --method node
```

### systemd

```bash
DEPLOY_METHOD=systemd \
DEPLOY_SYSTEMD_SERVICES="isalvei.service" \
./scripts/deploy.sh
```

- O script valida `WorkingDirectory` e reinicia as unidades via `systemctl`.
- Requer root ou `sudo -n` (sudo sem senha). Para desabilitar sudo:
  `DEPLOY_USE_SUDO=0`.
- Para `--process both`, informe duas unidades separadas por espaço.
- Se a unidade já estiver rodando, o script usa o `PATH` e as variáveis do
  processo real (`/proc/<pid>/environ`). Se estiver parada, usa o `Environment`
  da unidade e, na falta dele, o `PATH` padrão do sistema.

### PM2

```bash
DEPLOY_METHOD=pm2 DEPLOY_PM2_APPS="isalvei" ./scripts/deploy.sh
```

- Requer `pm2` e `jq`.
- O restart usa `pm2 restart <app> --update-env` seguido de `pm2 save`.

### Docker

```bash
DEPLOY_METHOD=docker \
DEPLOY_DOCKER_CONTAINER=isalvei \
DEPLOY_DOCKER_IMAGE=isalvei \
DEPLOY_DOCKER_PORTS="0.0.0.0:3000:3000" \
./scripts/deploy.sh
```

- O script constrói uma nova imagem (`isalvei:<timestamp>`) com o `yt-dlp`
  fixado via `--build-arg YTDLP_VERSION=...`.
  A imagem instala `yt-dlp[default,curl-cffi]` (EJS/impersonation). Em
  instalações não-Docker, prefira venv/pipx a pacotes `apt`/standalone antigos.
- A imagem anterior é preservada como `isalvei:previous-<timestamp>`.
- O container anterior é parado e renomeado para
  `isalvei-previous-<timestamp>`; ele não é removido automaticamente, para
  permitir rollback.
- O novo container reaproveita mounts, portas publicadas, rede, usuário,
  working dir, política de restart e variáveis de ambiente do container
  anterior. O `.env` do diretório da aplicação é aplicado depois e tem
  precedência.
- O volume `data/` é preservado; em primeiro deploy, `APP_DIR/data` é montado
  em `/app/data`.
- O `Dockerfile` usa um virtualenv em `/opt/yt-dlp`; não faz `pip install` no
  Python gerenciado pelo sistema operacional. Ele instala
  `yt-dlp[default,curl-cffi]` (EJS do YouTube e impersonation do TikTok) e usa
  Node 22 como runtime JavaScript.
- Health check: tenta a porta publicada; se não houver porta publicada, executa
  o health check dentro do container com `docker exec`.
- `--yt-dlp-only` no Docker sempre recria o container (é necessário para trocar
  o binário). `--no-restart` é rejeitado nesse modo.

Para primeiro deploy com container ainda inexistente, defina
`DEPLOY_DOCKER_CONTAINER`; o script cria o container com as opções padrão.

### Node direto (fallback)

```bash
DEPLOY_METHOD=node ./scripts/deploy.sh
```

- O script encontra processos `node .../server.js` (ou `api_server.js`) cujo
  `cwd` seja `APP_DIR`.
- Encerra com `SIGTERM`, aguarda até 20s e só então usa `SIGKILL` se necessário.
- Sobe com `nohup node <entry> >> .deploy/logs/app-<entry>.log`.
- **Não é um supervisor.** Para produção, prefira systemd ou Docker.

## 5. Atualização do yt-dlp

O método é detectado no executável realmente resolvido para o backend:

| Método | Detecção | Atualização | Versão fixa |
|---|---|---|---|
| `pip` | launcher Python + `pip show yt-dlp` | `<python> -m pip install --upgrade yt-dlp==X` | sim |
| `venv` | interpretador dentro de virtualenv | pip do próprio venv | sim |
| `pipx` | caminho em `.../pipx/venvs/...` | `pipx install --force yt-dlp==X` | sim |
| `apt` | `dpkg -S` aponta pacote `yt-dlp` | `apt-get update` + `apt-get install --only-upgrade yt-dlp` | não |
| `standalone` | binário grande/ELF/zipapp | download do release + checksum SHA-256 + troca atômica | sim |
| Docker | container | rebuild da imagem com `YTDLP_VERSION` | sim |

Regras de segurança:

- Nunca usa `sudo pip install` no Python do sistema.
- Se o pip bloquear por PEP 668, o deploy falha e orienta usar venv/pipx/standalone.
- `apt` não permite fixar versão arbitrária; `--yt-dlp-version` é rejeitado
  nesse método.
- No modo `standalone`, o checksum é obrigatório e a troca é atômica.
- Antes de atualizar, o script tenta baixar o wheel/.deb/binário atual para
  rollback offline.
- Se a atualização falhar ou a versão instalada divergir da alvo, o rollback é
  acionado.
- O script confirma que o executável resolvido pelo backend é exatamente o
  atualizado, via `scripts/runtime-check.js`.
- `FFmpeg` também é validado no mesmo ambiente.

### Versão fixa

```bash
./scripts/deploy.sh --yt-dlp-version 2026.03.17
# ou
DEPLOY_YTDLP_VERSION=2026.10.26 ./scripts/deploy.sh
```

Formato aceito: `YYYY.MM.DD` (ex.: `2026.03.17`). A versão instalada é
comparada com a alvo; divergência causa falha e rollback.

## 6. Variáveis de ambiente

### Aplicação (`.env`, preservado)

| Variável | Uso |
|---|---|
| `PORT` | porta do `server.js` (health check) |
| `API_PORT` | porta do `api_server.js` |
| `API_DB_PATH` | banco SQLite; backup inclui esse arquivo |
| `TMP_DIR` | diretório temporário dos downloads |
| `COOKIES_FILE` | cookies do yt-dlp (copiado se estiver em `APP_DIR`) |
| `YTDLP_PATH` | executável do yt-dlp usado pelo backend |
| `FFMPEG_PATH` | executável do FFmpeg |
| `FFPROBE_PATH` | executável do ffprobe |
| `RATE_LIMIT_*`, `MAX_*` | configurações da aplicação |

O script **não imprime** valores do `.env`, `COOKIES_FILE` ou variáveis de
segredo. O backup do `.env` e de cookies usa permissão `600`.

### Deploy

| Variável | Padrão | Descrição |
|---|---|---|
| `APP_DIR` | pai de `scripts/` | diretório da aplicação |
| `DEPLOY_METHOD` | `auto` | `auto/systemd/pm2/docker/node` |
| `DEPLOY_BRANCH` | `main` | branch de produção |
| `DEPLOY_REMOTE` | `origin` | remote Git |
| `DEPLOY_PROCESS` | `server` | `server/api/both` |
| `DEPLOY_STATE_DIR` | `$APP_DIR/.deploy` | backups, logs, relatórios e lock |
| `DEPLOY_BACKUP_KEEP` | `5` | backups mantidos (`0` desabilita poda) |
| `DEPLOY_MIN_DISK_MB` | `2048` | espaço mínimo livre |
| `DEPLOY_HEALTH_TIMEOUT` | `90` | timeout do health check (s) |
| `DEPLOY_PROCESS_WAIT` | `30` | espera pelo processo ficar ativo (s) |
| `DEPLOY_HEALTH_URL` | vazio | URL de health customizada |
| `DEPLOY_SYSTEMD_SERVICES` | vazio | unidades separadas por espaço |
| `DEPLOY_PM2_APPS` | vazio | apps PM2 separados por espaço |
| `DEPLOY_DOCKER_CONTAINER` | vazio | nome do container |
| `DEPLOY_DOCKER_IMAGE` | `isalvei` | repositório/tag base da imagem |
| `DEPLOY_DOCKER_PORTS` | vazio | ex.: `0.0.0.0:3000:3000` |
| `DEPLOY_DOCKER_VOLUMES` | vazio | volumes extras `host:container` |
| `DEPLOY_DOCKER_RUN_ARGS` | vazio | argumentos extras para `docker run` |
| `DEPLOY_DOCKER_CMD` | vazio | sobrescreve o comando do container |
| `DEPLOY_DOCKER_PULL` | `0` | usa `--pull` no build |
| `DEPLOY_YTDLP_METHOD` | `auto` | `pipx/venv/pip/apt/standalone` |
| `DEPLOY_YTDLP_VERSION` | vazio | versão fixa do yt-dlp |
| `DEPLOY_RUN_TESTS` | `1` | executa `npm test` |
| `DEPLOY_SKIP_NPM` | `0` | não roda `npm ci` (não recomendado) |
| `DEPLOY_ALLOW_DIRTY` | `0` | permite alterações locais rastreadas |
| `DEPLOY_ROLLBACK` | `1` | rollback automático em falha |
| `DEPLOY_USE_SUDO` | `auto` | `auto/1/0` |
| `DEPLOY_SKIP_NETWORK_CHECK` | `0` | pula verificação de rede (não recomendado) |
| `YTDLP_VERSION` | vazio | alias de `DEPLOY_YTDLP_VERSION` |

## 7. O que o deploy faz

1. Valida diretório, `package.json`, `server.js`, dependências, a versão
   mínima de Node declarada em `engines` (atualmente >= 22), permissões,
   espaço em disco e conectividade.
2. Adquire lock exclusivo em `.deploy/deploy.lock` (impede execuções
   simultâneas).
3. Detecta o método de execução e o ambiente real do backend.
4. Valida branch (`main` por padrão), alterações rastreadas e arquivos não
   rastreados que poderiam conflitar.
5. Cria ponto de recuperação: commit anterior, `git bundle`, `.env`, banco
   SQLite, `data/`, cookies (quando dentro de `APP_DIR`) e dados do container.
6. Faz `git fetch` e somente `git merge --ff-only`; nunca usa
   `git reset --hard` nem `git clean -fd`.
7. Instala dependências com `npm ci` quando há `package-lock.json`.
8. Executa `node --check`, checagem dos scripts do frontend e `npm test`.
9. Atualiza o `yt-dlp` no ambiente correto e valida versão/executável.
10. Reinicia/recria o processo pelo mecanismo detectado.
11. Aguarda o processo, chama `GET /health`, valida `yt-dlp`/`FFmpeg` com o
    ambiente do serviço e procura erros críticos nos logs de inicialização.
12. Grava relatório em `.deploy/reports/` com data, duração, commits, versões,
    método, backup e resultado.

## 8. Permissões

- Escrita em `APP_DIR` (para `git merge`/`npm ci`) e em `APP_DIR/.deploy`.
- Escrita no executável do `yt-dlp` quando for standalone. Para pip/venv/pipx,
  o usuário do serviço precisa poder instalar no ambiente correspondente.
- `sudo -n` para `systemctl restart` e para `apt` (se aplicável).
- Acesso ao socket Docker (grupo `docker` ou `sudo -n`), incluindo permissão
  para `stop`, `rename`, `run` e `rm` de containers.
- Leitura dos logs (`journalctl`, `pm2 logs` ou `docker logs`).
- Se rodar como root, os arquivos criados podem ficar com dono root; prefira o
  usuário da aplicação.

## 9. Health checks e testes

- HTTP: `GET /health` deve retornar `200` e `{"ok":true}`.
- Processo ativo (systemd/PM2/Node/Docker).
- `yt-dlp --version`, `ffmpeg -version` e `ffprobe -version` no ambiente do
  backend.
- Versão do `yt-dlp` igual à versão alvo.
- Executável resolvido pelo backend igual ao atualizado.
- Logs de inicialização sem `EADDRINUSE`, `Cannot find module`,
  `MODULE_NOT_FOUND`, `UnhandledPromiseRejection`, `FATAL ERROR`,
  `Segmentation fault`, `exec format error`, etc.
- `npm test` (quando configurado). O `npm test` executa os testes de download
  (`test:download`) e os testes do deploy (`test:deploy`). O script
  `scripts/tests/deploy_test.sh` valida o próprio deploy com binários falsos e
  dry-run, sem tocar em produção.
- No modo Docker, os testes completos rodam no host quando `node_modules` está
  disponível; dentro da imagem rodam verificações de sintaxe, os testes do
  deploy e o runtime check (`yt-dlp`/`FFmpeg`/`ffprobe`).

## 10. Logs

- Log completo de cada execução: `.deploy/logs/deploy-<timestamp>.log`.
- Relatórios JSON: `.deploy/reports/deploy-<timestamp>-<status>.json` e
  symlink `last-success.json`/`last-failed.json`.
- systemd: `journalctl -u <unidade> -f`.
- PM2: `pm2 logs <app>`.
- Docker: `docker logs -f <container>`.
- Node direto: `.deploy/logs/app-server.js.log` e
  `.deploy/logs/app-api_server.js.log`.

Segredos não são gravados nos logs pelo script. Ainda assim, restrinja o acesso
a `.deploy/` (backups contêm `.env`).

## 11. Rollback

### Automático

Se algo falhar depois do ponto de recuperação, o script tenta:

1. restaurar o `yt-dlp` anterior (wheel/.deb/binário ou reinstalação fixada);
2. restaurar o código com `git switch --detach <commit-anterior>` (sem
   `reset --hard`);
3. reinstalar dependências com `npm ci` da versão anterior;
4. reiniciar o serviço e repetir health check/runtime check;
5. no Docker, parar/remover o container novo, renomear o anterior de volta e
   iniciá-lo; a imagem anterior permanece tagueada.

O worktree fica **detached** após rollback de código. Para voltar a desenvolver
ou publicar de novo:

```bash
git switch main
```

### Manual

O relatório de falha e o resumo mostram os comandos. Exemplo fora do Docker:

```bash
cd /caminho/do/iSalvei
git switch --detach <commit-anterior>
npm ci --omit=dev
# yt-dlp, conforme o método:
#   venv/pip: /caminho/venv/bin/python -m pip install --force-reinstall yt-dlp==<versao>
#   pipx:     pipx install --force yt-dlp==<versao>
#   apt:      sudo apt-get install --allow-downgrades -y yt-dlp=<versao-deb>
#   standalone: instalar o binário salvo em .deploy/backups/<id>/ytdlp/yt-dlp.bin
sudo systemctl restart isalvei.service   # ou o mecanismo real
curl -fsS http://127.0.0.1:3000/health
```

No Docker:

```bash
docker stop isalvei
docker rm isalvei
docker rename isalvei-previous-<ts> isalvei
docker start isalvei
# imagem anterior: isalvei:previous-<ts>
```

### Limitações de rollback

- **Banco de dados não é restaurado automaticamente.** O backup é feito, mas
  uma restauração poderia apagar dados gravados depois do deploy. Restaure
  manualmente, com a aplicação parada, se necessário.
- Migrações de banco (se adicionadas no futuro) não são revertidas
  automaticamente.
- Uma atualização do `yt-dlp` pode não ter rollback offline se o wheel/.deb
  antigo não puder ser baixado; o script tenta reinstalar pela rede e avisa.
- `apt` pode não manter a versão antiga disponível no repositório.
- Dependências nativas do Node podem exigir ferramentas de build; se o
  `npm ci` antigo falhar, o rollback fica incompleto.
- O rollback do Docker depende de o container/imagem antigos não terem sido
  removidos manualmente.
- O script não reverte alterações externas ao Git, arquivos não rastreados ou
  configurações de proxy/reverse proxy.

## 12. O que depende do ambiente de produção

Não foi possível validar contra a produção real. Estas etapas precisam ser
confirmadas no servidor:

- Nome real da unidade systemd/processo PM2/container e diretório da aplicação.
- `PATH`, `YTDLP_PATH` e `FFMPEG_PATH` efetivamente usados pelo serviço.
- Método real de instalação do `yt-dlp` (pip, venv, pipx, apt, binário ou
  imagem Docker).
- Porta local do health check e se há reverse proxy/HTTPS.
- Permissões de `sudo`, Docker e escrita nos diretórios.
- Origem dos dados persistentes (volume Docker, `data/`, cookies).
- Se `api_server.js` também roda em produção.
- Política de retenção de backups e espaço em disco.

Faça o primeiro deploy em produção primeiro com `--dry-run` e depois em uma
janela de manutenção. O script nunca faz deploy sozinho.

## 13. Solução de problemas

| Sintoma | Verificação |
|---|---|
| `Não foi possível detectar...` | use `--method` e configure serviço/container/app |
| `Branch atual ... difere` | `git switch main` antes do deploy |
| `Há alterações locais rastreadas` | commit/stash; não use `--allow-dirty` sem revisar |
| `yt-dlp não encontrado` | confira `YTDLP_PATH`/`PATH` do processo; use `--dry-run` |
| `Versão instalada difere` | veja se o serviço usa outro binário; confira `YTDLP_PATH` |
| `Health check falhou` | veja logs, porta, processo e `/health` manualmente |
| `PEP 668` no pip | migre para venv/pipx/standalone; não use `--break-system-packages` |
| Rollback deixou worktree detached | `git switch main` |
| Container anterior ficou parado | remova após validar: `docker rm isalvei-previous-<ts>` |

## 14. Segurança

- O script não imprime valores de `.env`.
- Backups de `.env`/cookies têm permissão `600`; o diretório do backup, `700`.
- Não usa `git reset --hard`, `git clean -fd`, `rm -rf` do repositório nem
  `sudo pip install`.
- O merge é sempre `--ff-only`; divergências são reportadas, não forçadas.
- A poda de backups só ocorre dentro de `.deploy/backups` e mantém os N mais
  recentes.
