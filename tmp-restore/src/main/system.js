'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

let lastCpu = sampleCpu();

function sampleCpu() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function cpuPercent() {
  const current = sampleCpu();
  const idleDelta = current.idle - lastCpu.idle;
  const totalDelta = current.total - lastCpu.total;
  lastCpu = current;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

function memoryStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalMb: Math.round(total / 1048576),
    usedMb: Math.round(used / 1048576),
    percent: Math.round((used / total) * 100)
  };
}

function javaVersionOf(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stderr || ''}${stdout || ''}`;
      const match = /version "([^"]+)"/.exec(text);
      if (!match) return resolve(null);
      const major = Number((match[1].match(/^(\d+)/) || [])[1]) || 0;
      resolve({ version: match[1], major: major === 1 ? Number(match[1].split('.')[1]) || 8 : major });
    });
  });
}

function javaCandidates(gameDir, preferred) {
  const list = [];
  if (preferred) list.push(preferred);
  if (process.env.JAVA_HOME) {
    list.push(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java'));
  }
  if (gameDir) {
    const runtimeDir = path.join(gameDir, 'runtime');
    try {
      for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const base = path.join(runtimeDir, entry.name);
        const nested = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
        for (const sub of nested) {
          const bin = path.join(base, sub.name, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
          if (fs.existsSync(bin)) list.push(bin);
        }
      }
    } catch {
      /* no runtime folder */
    }
  }
  if (process.platform === 'win32') {
    list.push(path.join('C:\\', 'Program Files', 'Java', 'latest', 'bin', 'javaw.exe'));
    list.push(path.join('C:\\', 'Program Files', 'Eclipse Adoptium', 'jdk-21', 'bin', 'javaw.exe'));
  }
  list.push(process.platform === 'win32' ? 'java' : 'java');
  return [...new Set(list)];
}

/** Every usable Java runtime on this machine, best-known first. */
async function detectJavaRuntimes(gameDir, preferred) {
  const found = [];
  const seen = new Set();
  for (const candidate of javaCandidates(gameDir, preferred)) {
    if (candidate !== 'java' && !fs.existsSync(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const info = await javaVersionOf(candidate);
    if (info) found.push({ path: candidate, version: info.version, major: info.major });
  }
  return found;
}

/** Prefers an explicit path, then the runtime that matches the required major version. */
async function detectJava(gameDir, preferred, requiredMajor) {
  if (preferred && preferred !== 'java') {
    const explicit = await javaVersionOf(preferred);
    if (explicit) return { path: preferred, version: explicit.version, major: explicit.major };
  }
  const runtimes = await detectJavaRuntimes(gameDir, preferred);
  if (!runtimes.length) return null;
  if (!requiredMajor) return [...runtimes].sort((a, b) => b.major - a.major)[0];
  const exact = runtimes.find((runtime) => runtime.major === requiredMajor);
  if (exact) return exact;
  const newer = runtimes
    .filter((runtime) => runtime.major > requiredMajor)
    .sort((a, b) => a.major - b.major)[0];
  if (newer) return newer;
  return [...runtimes].sort((a, b) => b.major - a.major)[0];
}

module.exports = { cpuPercent, memoryStats, detectJava, detectJavaRuntimes, javaVersionOf };
