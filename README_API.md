# API v1 - Usage

## Register (create API key)
```
POST /api/register
Content-Type: application/json
Body: { "quota": 10 }
```
Returns:
```json
{ "api_key": "abcd1234...", "quota_per_minute": 10 }
```

## Download
```
GET /api/download?url=<URL>&format=best|720|480|audio
Header: X-API-KEY: <your_key>
```
Response: attachment with the video/audio.

O `format` é opcional e o default é `best`. Também é possível usar
`Authorization: Bearer <key>`. O parâmetro `?key=` continua aceito por
compatibilidade, mas o header é recomendado para não vazar a chave em logs.

## Example with curl
```bash
# register (one-time)
curl -s -X POST http://localhost:3000/api/register -H "Content-Type: application/json" -d '{"quota":10}'

# use the key to download
curl -L -H "X-API-KEY: <YOUR_KEY>" \
  "http://localhost:3000/api/download?url=https://www.instagram.com/reel/XXXXXXXX/&format=720" \
  --output video.mp4
```

## Erros

As respostas de erro têm o formato:

```json
{ "error": "mensagem para o usuário", "code": "CODIGO_ESTAVEL", "requestId": "..." }
```

| HTTP | Código | Significado |
|---|---|---|
| 400 | `URL_REQUIRED`, `URL_NOT_ALLOWED`, `INVALID_FORMAT` | URL/formato inválido ou host não permitido |
| 403 | `AUTH_REQUIRED`, `GEO_BLOCKED` | Login/cookies necessários ou restrição geográfica. `AUTH_REQUIRED` inclui `loginRequired: true` |
| 404 | `NOT_AVAILABLE` | Conteúdo removido/indisponível |
| 413 | `FILE_TOO_LARGE` | Acima de `MAX_FILE_SIZE` |
| 422 | `UNSUPPORTED_PLATFORM`, `NO_VIDEO`, `DRM_PROTECTED`, `LIVE_NOT_SUPPORTED` | Plataforma/conteúdo não suportado |
| 429 | `RATE_LIMITED`, `PLATFORM_RATE_LIMITED` | Limite do servidor ou da plataforma |
| 503/504 | `SERVER_BUSY`, `DEPENDENCY_MISSING`, `TIMEOUT` | Servidor ocupado, dependência ausente ou timeout |

## Health
```
GET /health
```
Retorna `{ "ok": true|false, "checks": { "ytdlp": true, "ffmpeg": true, "ffprobe": true, "tmp": true, "cookies": "not_configured", "instagramLogin": "ready|unavailable|disabled" } }`.
