#!/usr/bin/env node
'use strict';

/**
 * Backup consistente de um banco SQLite usando better-sqlite3 (já presente
 * nas dependências da aplicação). Uso:
 *
 *   node scripts/db-backup.js <origem> <destino>
 *
 * Código de saída != 0 em caso de falha. Não imprime conteúdo do banco.
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const [, , source, destination] = process.argv;

  if (!source || !destination) {
    process.stderr.write('Uso: node scripts/db-backup.js <origem> <destino>\n');
    process.exit(2);
  }

  if (!fs.existsSync(source)) {
    process.stderr.write(`[db-backup] Banco não encontrado: ${source}\n`);
    process.exit(3);
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    process.stderr.write(`[db-backup] better-sqlite3 indisponível: ${error.message}\n`);
    process.exit(4);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) fs.unlinkSync(destination);

  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
    process.stdout.write('ok\n');
  } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
}

main().catch((error) => {
  process.stderr.write(`[db-backup] Falha: ${error.message}\n`);
  process.exit(5);
});
