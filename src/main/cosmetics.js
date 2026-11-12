'use strict';

/**
 * SallyClient cosmetics shop.
 *
 * The client ships the catalogue in its jar: `assets/sallyclient/cosmetics/models`
 * has name, slot, collection and price, and `assets/sallyclient/textures/gui/
 * cosmetics/<id>.png` is the 2D artwork the in-game shop draws. The worn items
 * live in the profile's `config/sallyclient.json` (`cosmetics`), which is what
 * the toggle below writes.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const clientmod = require('./clientmod');

const MODEL_DIR = 'assets/sallyclient/cosmetics/models/';
const GUI_DIR = 'assets/sallyclient/textures/gui/cosmetics/';
const CONFIG_FILE = path.join('config', 'sallyclient.json');

let cache = { key: '', items: [], version: '' };

function shippedJar() {
  try {
    const dir = path.join(__dirname, '..', '..', 'assets', 'mods');
    const name = fs.readdirSync(dir).find((entry) => /^sallyclient-.*\.jar$/i.test(entry));
    return name ? path.join(dir, name) : null;
  } catch {
    return null;
  }
}

async function resolveJar() {
  try {
    const build = await clientmod.ensure();
    if (build?.path && fs.existsSync(build.path)) return { file: build.path, version: build.version };
  } catch {
    /* offline – fall back to the shipped build */
  }
  const cached = await clientmod.cachedJar().catch(() => null);
  if (cached?.path && fs.existsSync(cached.path)) return { file: cached.path, version: cached.version };
  const shipped = shippedJar();
  return shipped ? { file: shipped, version: '' } : null;
}

function dataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function readItems(jar) {
  const zip = new AdmZip(jar);
  const art = new Map();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith(GUI_DIR) || !entry.entryName.endsWith('.png')) continue;
    const id = path.basename(entry.entryName, '.png');
    if (id.startsWith('bg_') || id.startsWith('header_') || id === 'gift_box') continue;
    art.set(id, dataUrl(zip.readFile(entry)));
  }

  const items = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.startsWith(MODEL_DIR) || !entry.entryName.endsWith('.json')) continue;
    let model = null;
    try {
      model = JSON.parse(zip.readAsText(entry));
    } catch {
      continue;
    }
    if (!model?.id || !model?.name) continue;
    // Only items the shop really sells: every shipped cosmetic has artwork in
    // assets/sallyclient/textures/gui/cosmetics (little_star does not, it is not in the shop).
    if (!art.has(String(model.id))) continue;
    items.push({
      id: String(model.id),
      name: String(model.name),
      slot: String(model.slot || 'cosmetic'),
      collection: String(model.collection || ''),
      price: Number(model.price) || 0,
      image: art.get(String(model.id)) || null
    });
  }
  items.sort((a, b) => a.collection.localeCompare(b.collection) || a.name.localeCompare(b.name));
  return items;
}

async function catalogue() {
  const jar = await resolveJar();
  if (!jar) throw new Error('No SallyClient build found yet.');
  let size = 0;
  try {
    size = fs.statSync(jar.file).size;
  } catch {
    size = 0;
  }
  const key = `${jar.file}:${size}`;
  if (cache.key !== key) cache = { key, items: readItems(jar.file), version: jar.version };
  return cache;
}

function configFile(gameDir) {
  return gameDir ? path.join(gameDir, CONFIG_FILE) : '';
}

async function readConfig(gameDir) {
  const file = configFile(gameDir);
  if (!file) return null;
  try {
    return { file, data: JSON.parse(await fsp.readFile(file, 'utf8')) };
  } catch {
    return null;
  }
}

const keyOf = (id) => String(id || '').toUpperCase();

async function list({ gameDir } = {}) {
  const { items, version } = await catalogue();
  const config = await readConfig(gameDir);
  const worn = new Set((config?.data?.cosmetics || []).map(keyOf));
  const owned = new Set((config?.data?.ownedCosmetics || []).map(keyOf));
  return {
    version,
    configured: Boolean(config?.data),
    items: items.map((item) => ({
      ...item,
      worn: worn.has(keyOf(item.id)),
      owned: owned.has(keyOf(item.id))
    }))
  };
}

async function toggle({ gameDir, id } = {}) {
  const key = keyOf(id);
  if (!key) throw new Error('Unknown cosmetic.');
  const config = await readConfig(gameDir);
  if (!config?.data) {
    throw new Error('Start SallyClient once for this profile so it writes config/sallyclient.json.');
  }
  const current = Array.isArray(config.data.cosmetics) ? config.data.cosmetics.map(String) : [];
  const remaining = current.filter((entry) => keyOf(entry) !== key);
  const worn = remaining.length === current.length ? [...current, key] : remaining;
  config.data.cosmetics = worn;
  await fsp.mkdir(path.dirname(config.file), { recursive: true });
  await fsp.writeFile(config.file, JSON.stringify(config.data, null, 2), 'utf8');
  return { worn, removed: remaining.length !== current.length };
}

module.exports = { list, toggle };
