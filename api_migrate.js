// small migration / helper to create an initial API key
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();
const DB_PATH = process.env.API_DB_PATH || path.join(__dirname, 'data', 'api.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    api_key TEXT UNIQUE,
    created_at INTEGER,
    quota_per_minute INTEGER DEFAULT 10
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    api_key TEXT,
    timestamp INTEGER
  );
`);
const key = uuidv4().replace(/-/g,'');
const quota = 20;
const stmt = db.prepare('INSERT INTO api_keys (api_key, created_at, quota_per_minute) VALUES (?, ?, ?)');
stmt.run(key, Date.now(), quota);
console.log('Created API key:', key, 'quota_per_minute:', quota);
