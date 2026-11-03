'use strict';

/**
 * Shipped defaults.
 *
 * The launcher keeps build-time values in `.env` instead of showing them in
 * the settings UI. A real environment variable always wins, so a release can
 * be pointed at another Discord application without touching the code.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function parseEnv(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readEnvFile() {
  const candidates = [
    path.join(app.getAppPath(), '.env'), /* packaged: inside app.asar */
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '..', '.env')
  ];
  for (const file of candidates) {
    try {
      return parseEnv(fs.readFileSync(file, 'utf8'));
    } catch {
      /* try the next location */
    }
  }
  return {};
}

const fileEnv = readEnvFile();

function value(key, fallback = '') {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && String(fromProcess).trim() !== '') return String(fromProcess).trim();
  const fromFile = fileEnv[key];
  if (fromFile !== undefined && String(fromFile).trim() !== '') return String(fromFile).trim();
  return fallback;
}

module.exports = {
  discordClientId: value('DISCORD_CLIENT_ID')
};
