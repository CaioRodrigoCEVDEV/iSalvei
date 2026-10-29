# Interface do iSalvei

Este documento resume a refatoração visual com foco no download e registra os
testes e as limitações conhecidas.

## Estrutura da interface

- `frontend/index.html`: cabeçalho compacto, hero com formulário, estados de
  processamento/sucesso, passos, plataformas e rodapé.
- `frontend/assets/css/style.css`: tokens de cor/espaçamento, layout responsivo,
  estados de foco, spinner, progresso indeterminado e preferência por movimento
  reduzido.
- `frontend/script.js`: validação local da URL, colar/limpar, submissão única,
  leitura do arquivo com progresso real quando `Content-Length` está disponível,
  tratamento dos códigos de erro, conexão opcional da conta do Instagram e ação
  de salvar novamente.
- Painel de sessão do Instagram (`/api/instagram/session`): mostra o estado da
  conta conectada. Quando o backend responde `AUTH_REQUIRED` com
  `loginRequired: true`, abre um diálogo com a tela real de login do Instagram
  transmitida por SSE (`/api/instagram/login/:id/stream`). O usuário clica na
  imagem, digita em um campo auxiliar e resolve 2FA/desafios normalmente; o
  backend captura só os cookies e o download é repetido automaticamente. A opção
  avançada de colar `sessionid`/`cookies.txt` fica recolhida no mesmo diálogo.
- `frontend/assets/js/i18n.js`: mesmas oito localidades existentes (`pt-BR`,
  `en`, `es`, `fr`, `de`, `it`, `ja`, `zh-CN`).
- `frontend/sw.js`: cache versionado, precache dos assets novos e atualização do
  PWA sem manter CSS/JS antigos.

## Contratos preservados

- Rota usada pelo frontend: `GET /api/download?url=...&format=...`.
- Formatos enviados ao backend: `best`, `720`, `480`, `audio`.
- O nome e a extensão do arquivo continuam vindo de `Content-Disposition`.
- Erros continuam sendo lidos do JSON do backend (`code` e `error`), com
  `Retry-After` respeitado em limites de requisição.
- O download automático do arquivo preparado continua acontecendo; o botão
  **Salvar arquivo** permite repetir a ação e **Novo download** reinicia o
  formulário.
- O botão de instalação do PWA, o registro do service worker e o seletor de
  idioma foram mantidos.

## Estados do formulário

1. Inicial: campo disponível e formulário sem animação de entrada.
2. Validação: mensagem curta junto ao campo, `aria-invalid` e sem `alert`
   nativo.
3. Preparação: submissão desabilitada, spinner e barra indeterminada.
4. Transferência: quando o backend começa a enviar o arquivo, a mensagem muda
   para “Recebendo o arquivo...”. O percentual só aparece quando o
   `Content-Length` real está disponível.
5. Sucesso: confirmação discreta, nome completo do arquivo e ações de salvar
   novamente ou iniciar outro download.
6. Erro: mensagens localizadas para URL inválida, conteúdo indisponível/privado,
   plataforma fora do ar, limite de requisições, timeout, falha de rede e falha
   na preparação. Em `AUTH_REQUIRED` de um link do Instagram, abre o diálogo de
   conexão da conta; ao conectar, o download é refeito automaticamente. Detalhes
   técnicos ficam no console e nos logs do servidor.
7. Sessão do Instagram: desconectada (botão “Conectar conta”), conectada
   (indicador verde e botão “Desconectar”), carregando o Chromium, tela de login
   ao vivo, conexão perdida com botão “Tentar novamente”, navegador indisponível
   (com a opção manual aberta) e erro de cookies inválidos, com foco e
   `role="alert"`.

## Acessibilidade

- Rótulos visíveis ou `sr-only` para campo, qualidade e idioma.
- `aria-live`, `role="status"`, `role="alert"` e `role="progressbar"` nos estados
  dinâmicos.
- Foco visível, `aria-invalid`, mensagens associadas ao campo e foco devolvido ao
  campo em erros de URL.
- Áreas de toque ampliadas no mobile e `prefers-reduced-motion` respeitado.

## Testes executados

```bash
node --check frontend/script.js
node --check frontend/assets/js/i18n.js
node --check frontend/sw.js
npm test
```

Resultados:

- `npm test`: 61 testes de backend aprovados, 6 testes live ignorados (opt-in) e
  21 testes de deploy aprovados.
- Validação de sintaxe JavaScript: aprovada.
- Validação estrutural do HTML: aprovada.
- Testes automatizados de interface em Chrome headless: 79 verificações
  aprovadas, incluindo:
  - colar/limpar e falha de permissão do clipboard;
  - URL vazia, inválida e plataforma não suportada;
  - processamento, sucesso, nome do arquivo e download real do blob;
  - limite de requisições com `Retry-After`, conteúdo privado, timeout e falha
    de rede;
  - troca de idioma e todas as localidades em 360 px;
  - larguras de 360, 390, 768, 1024 e 1440 px sem rolagem horizontal;
  - service worker ativo, cache novo e assets versionados no precache;
  - ausência de exceções, erros de console inesperados e falhas de requisição
    inesperadas.

Screenshots antes/depois foram geradas fora do repositório, em `/tmp`, para
comparação visual durante a refatoração.

## Limitações

- **Download externo real:** a suíte padrão usa o backend com `yt-dlp` simulado e
  valida o contrato HTTP. Os testes live de YouTube, Instagram, TikTok e Facebook
  são opt-in (`npm run test:live`) e não foram executados nesta refatoração.
- **Progresso:** a barra só mostra porcentagem quando o servidor envia
  `Content-Length`. Caso contrário, permanece indeterminada.
- **Clipboard:** `navigator.clipboard.readText()` exige contexto seguro e
  permissão do navegador. Sem isso, a interface orienta a colar manualmente.
- **Kwai:** o backend mantém o Kwai como não suportado. Por isso a interface
  mostra “Em breve” em vez de prometer compatibilidade.
- **Instalação do PWA:** o registro do service worker, o cache novo e o precache
  dos assets foram validados. A conclusão da instalação não é automatizável no
  Chrome headless usado nos testes.
- **Deploy:** nenhum deploy ou publicação em produção foi executado.
