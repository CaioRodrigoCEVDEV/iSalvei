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
GET /api/download?url=<URL>
Header: X-API-KEY: <your_key>
```
Response: attachment with the video.

## Example with curl
```bash
# register (one-time)
curl -s -X POST http://localhost:3000/api/register -H "Content-Type: application/json" -d '{"quota":10}'

# use the key to download
curl -L -H "X-API-KEY: <YOUR_KEY>" "http://localhost:3000/api/download?url=https://www.instagram.com/reel/XXXXXXXX/" --output video.mp4
```
