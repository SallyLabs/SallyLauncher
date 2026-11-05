'use strict';

/**
 * Builds the custom installer:
 *   1. copies the packaged launcher (dist/win-unpacked) into installer/payload
 *   2. syncs the version into installer/package.json + version.json
 *   3. runs electron-builder (portable) to produce dist/SallyLauncher-Setup-<version>.exe
 *
 * Usage: npm run dist   (runs `pack` first, then this script)
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const installerDir = path.join(root, 'installer');
const unpacked = path.join(root, 'dist', 'win-unpacked');
const payloadDir = path.join(installerDir, 'payload');

async function main() {
  const appPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = appPackage.version;

  if (!fs.existsSync(path.join(unpacked, 'SallyLauncher.exe'))) {
    throw new Error('dist/win-unpacked fehlt – erst "npm run pack" ausführen.');
  }

  console.log(`[setup] Payload aus ${unpacked} wird kopiert…`);
  await fsp.rm(payloadDir, { recursive: true, force: true });
  await fsp.cp(unpacked, payloadDir, { recursive: true });
  const payloadSize = (await fsp.stat(path.join(payloadDir, 'SallyLauncher.exe'))).size;
  console.log(`[setup] Payload bereit (${(payloadSize / 1048576).toFixed(1)} MB Launcher-Binary)`);

  await fsp.writeFile(
    path.join(installerDir, 'version.json'),
    JSON.stringify({ name: 'SallyLauncher', version }, null, 2)
  );

  const installerPackagePath = path.join(installerDir, 'package.json');
  const installerPackage = JSON.parse(fs.readFileSync(installerPackagePath, 'utf8'));
  if (installerPackage.version !== version) {
    installerPackage.version = version;
    await fsp.writeFile(installerPackagePath, `${JSON.stringify(installerPackage, null, 2)}\n`);
    console.log(`[setup] Installer-Version auf ${version} gesetzt`);
  }

  const electronVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
  ).version;

  console.log(`[setup] electron-builder (portable, Electron ${electronVersion})…`);
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
      '--win',
      'portable',
      `--config.electronVersion=${electronVersion}`,
      '--config',
      path.join(installerDir, 'electron-builder.yml')
    ],
    { cwd: installerDir, stdio: 'inherit', env: process.env }
  );

  /* The in-place updater only replaces app.asar, so the packed app ships as its
     own (few MB) release asset next to the setup. */
  /* The wrapper build below reuses dist/win-unpacked as its output folder, so
     the launcher asar is read from the finished payload copy. */
  const asarSource = path.join(payloadDir, 'resources', 'app.asar');
  if (fs.existsSync(asarSource)) {
    const asarTarget = path.join(root, 'dist', 'app.asar');
    await fsp.copyFile(asarSource, asarTarget);
    const asarSize = (await fsp.stat(asarTarget)).size;
    console.log(`[setup] Update-Payload: dist/app.asar (${(asarSize / 1048576).toFixed(1)} MB)`);
  }

  const artifact = path.join(root, 'dist', `SallyLauncher-Setup-${version}.exe`);
  if (!fs.existsSync(artifact)) throw new Error('Setup-EXE wurde nicht erzeugt.');
  const size = (await fsp.stat(artifact)).size;
  console.log(`[setup] Fertig: ${artifact} (${(size / 1048576).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(`[setup] Fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
