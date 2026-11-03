const setup = window.setup;

const el = (id) => document.getElementById(id);

const ui = {
  railSteps: el('railSteps'),
  railEdition: el('railEdition'),
  railVersion: el('railVersion'),
  railStep1: el('railStep1'),
  railStep2: el('railStep2'),
  railStep3: el('railStep3'),
  paneEyebrow: el('paneEyebrow'),
  footerNote: el('footerNote'),
  primary: el('primary'),
  secondary: el('secondary'),
  installDir: el('installDir'),
  dirHint: el('dirHint'),
  browse: el('browse'),
  welcomeTitle: el('welcomeTitle'),
  welcomeSub: el('welcomeSub'),
  progressTitle: el('progressTitle'),
  progressSub: el('progressSub'),
  progressLabel: el('progressLabel'),
  progressPercent: el('progressPercent'),
  progressFill: el('progressFill'),
  fileLine: el('fileLine'),
  stages: el('stages'),
  progressNote: el('progressNote'),
  doneTitle: el('doneTitle'),
  doneSub: el('doneSub'),
  donePath: el('donePath'),
  openFolder: el('openFolder'),
  errorText: el('errorText'),
  uninstallWarning: el('uninstallWarning'),
  uninstallPath: el('uninstallPath')
};

const state = {
  info: null,
  step: 'welcome',
  options: { desktop: true, startMenu: true, launch: true, keepUserData: false },
  target: '',
  installed: false
};

const CHECK =
  '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 12.5l4 4L19 7.5" /></svg>';

/* ------------------------------------------------------------------ steps */

function stepIndex(step) {
  if (step === 'progress') return 1;
  if (step === 'done') return 2;
  return 0;
}

function syncRail(step) {
  const index = stepIndex(step);
  [...ui.railSteps.children].forEach((node, position) => {
    node.classList.toggle('active', position === index);
    node.classList.toggle('done', position < index);
    const marker = node.querySelector('i');
    if (marker) marker.innerHTML = position < index ? CHECK : `<span>${position + 1}</span>`;
  });
}

function showStep(step) {
  state.step = step;
  document.querySelectorAll('.step').forEach((node) => {
    node.classList.toggle('active', node.dataset.step === step);
  });
  syncRail(step);
}

function setBusy(busy) {
  ui.primary.disabled = busy;
  ui.browse.disabled = busy;
  ui.installDir.disabled = busy;
  el('minimize').disabled = false;
  el('close').disabled = busy;
}

/* ---------------------------------------------------------------- options */

document.querySelectorAll('.switch').forEach((node) => {
  const key = node.dataset.key;
  const toggle = () => {
    const next = !node.classList.contains('on');
    node.classList.toggle('on', next);
    node.setAttribute('aria-checked', String(next));
    state.options[key] = next;
  };
  node.addEventListener('click', (event) => {
    event.preventDefault();
    toggle();
  });
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
});

ui.browse.addEventListener('click', async () => {
  const folder = await setup.pickFolder();
  if (folder) {
    state.target = folder;
    ui.installDir.value = folder;
  }
});

ui.installDir.addEventListener('input', () => {
  state.target = ui.installDir.value;
});

ui.openFolder.addEventListener('click', () => {
  if (state.target) setup.openFolder(state.target);
});

/* -------------------------------------------------------------- progress */

function stageOf(payload) {
  const order = document.body.classList.contains('uninstall')
    ? ['shortcuts', 'data', 'remove']
    : ['copy', 'shortcuts', 'registry'];
  const index = order.indexOf(payload.phase);
  return index === -1 ? 0 : index;
}

function setStageLabels(labels) {
  [...ui.stages.children].forEach((node, index) => {
    if (labels[index]) node.lastChild.textContent = ` ${labels[index]}`;
  });
}

function onProgress(payload) {
  const percent = Math.max(0, Math.min(100, Number(payload.percent) || 0));
  ui.progressFill.style.width = `${percent}%`;
  ui.progressPercent.innerHTML = `${percent}<i>%</i>`;

  if (payload.current) {
    const filePhase = payload.phase === 'copy' || payload.phase === 'remove';
    ui.progressLabel.textContent =
      payload.phase === 'copy'
        ? `Dateien werden kopiert · ${payload.done || 0} / ${payload.total || 0}`
        : payload.phase === 'remove'
          ? `Dateien werden entfernt · ${payload.done || 0} / ${payload.total || 0}`
          : payload.current;
    ui.fileLine.textContent = filePhase ? payload.current : '';
  }

  const current = stageOf(payload);
  [...ui.stages.children].forEach((node, index) => {
    node.classList.toggle('active', index === current);
    node.classList.toggle('done', index < current);
  });
}

/* ---------------------------------------------------------------- install */

async function startInstall() {
  const target = (state.target || ui.installDir.value || '').trim();
  if (!target) {
    ui.dirHint.textContent = 'Bitte einen Installationsordner wählen.';
    return;
  }
  state.target = target;
  document.body.classList.remove('uninstall');
  ui.progressTitle.textContent = 'Wird installiert…';
  ui.progressSub.textContent = 'Die Launcher-Dateien werden in den gewählten Ordner kopiert.';
  ui.progressNote.textContent = 'Du kannst das Setup minimieren. Die Kopie ist gedrosselt, damit Windows und andere Programme mehr Ressourcen behalten.';
  ui.paneEyebrow.textContent = 'Installation';
  showStep('progress');
  setBusy(true);
  ui.primary.classList.add('hidden');
  ui.secondary.classList.add('hidden');
  onProgress({ phase: 'start', percent: 0, current: 'Vorbereiten…' });
  try {
    const result = await setup.install({
      dir: target,
      desktop: state.options.desktop,
      startMenu: state.options.startMenu,
      launch: state.options.launch
    });
    finishInstall(result);
  } catch (err) {
    fail(err.message);
  }
}

function finishInstall(result) {
  state.installed = true;
  ui.doneTitle.textContent = 'SallyLauncher ist installiert';
  ui.doneSub.textContent = state.options.launch
    ? 'Der Launcher startet gleich – du kannst dieses Fenster schließen.'
    : 'Du findest den Launcher im Startmenü und auf dem Desktop.';
  ui.donePath.textContent = result.target;
  ui.donePath.title = result.target;
  state.target = result.target;
  ui.paneEyebrow.textContent = 'Fertig';
  ui.railStep3.textContent = 'Fertig';
  ui.primary.textContent = 'SallyLauncher starten';
  ui.primary.classList.remove('danger');
  ui.primary.classList.remove('hidden');
  ui.primary.disabled = false;
  ui.secondary.textContent = 'Schließen';
  ui.secondary.classList.remove('hidden');
  setBusy(false);
  showStep('done');
  if (state.options.launch) {
    setTimeout(() => {
      setup.launch(result.target).catch(() => {});
    }, 900);
  }
}

async function startUninstall() {
  ui.progressTitle.textContent = 'Wird deinstalliert…';
  ui.progressSub.textContent = 'Dateien, Verknüpfungen und Registry-Eintrag werden entfernt.';
  ui.paneEyebrow.textContent = 'Deinstallation';
  showStep('progress');
  setBusy(true);
  ui.primary.classList.add('hidden');
  ui.secondary.classList.add('hidden');
  onProgress({ phase: 'start', percent: 0, current: 'Vorbereiten…' });
  try {
    const result = await setup.uninstall({
      target: state.info.uninstallDir,
      keepUserData: state.options.keepUserData
    });
    ui.doneTitle.textContent = 'SallyLauncher wurde entfernt';
    ui.doneSub.textContent = state.options.keepUserData
      ? 'Deine Profile und Einstellungen bleiben erhalten.'
      : 'Auch Profile und Einstellungen wurden gelöscht.';
    ui.donePath.textContent = result.target;
    ui.donePath.title = result.target;
    state.target = result.target;
    ui.railStep3.textContent = 'Entfernt';
    ui.paneEyebrow.textContent = 'Fertig';
    ui.primary.textContent = 'Schließen';
    ui.primary.classList.remove('danger');
    ui.primary.classList.remove('hidden');
    ui.primary.disabled = false;
    ui.secondary.classList.add('hidden');
    setBusy(false);
    showStep('done');
  } catch (err) {
    fail(err.message);
  }
}

function fail(message) {
  ui.errorText.textContent = message || 'Unbekannter Fehler.';
  ui.paneEyebrow.textContent = 'Fehler';
  ui.primary.textContent = 'Zurück';
  ui.primary.classList.remove('hidden');
  ui.primary.disabled = false;
  ui.primary.classList.remove('danger');
  ui.secondary.textContent = 'Schließen';
  ui.secondary.classList.remove('hidden');
  setBusy(false);
  showStep('error');
}

/* ----------------------------------------------------------------- footer */

ui.primary.addEventListener('click', () => {
  if (state.step === 'welcome') {
    if (state.info.uninstall) startUninstall();
    else startInstall();
    return;
  }
  if (state.step === 'done') {
    if (state.installed) {
      setup.launch(state.target).catch((err) => fail(err.message));
      setTimeout(() => setup.close(), 400);
    } else {
      setup.close();
    }
    return;
  }
  if (state.step === 'error') {
    ui.paneEyebrow.textContent = state.info.uninstall ? 'Deinstallation' : 'Setup';
    showStep('welcome');
    ui.primary.classList.remove('hidden');
    ui.primary.textContent = state.info.uninstall ? 'Deinstallieren' : 'Installieren';
    ui.primary.classList.toggle('danger', Boolean(state.info.uninstall));
    ui.secondary.classList.add('hidden');
  }
});

ui.secondary.addEventListener('click', () => setup.close());
el('close').addEventListener('click', () => setup.close());
el('minimize').addEventListener('click', () => setup.minimize());

/* ------------------------------------------------------------------- boot */

function sizeLabel(bytes) {
  /* setup without a real payload (dev) would show a misleading number */
  if (!bytes || bytes < 10 * 1024 ** 2) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

async function boot() {
  state.info = await setup.info();
  state.target = state.info.uninstall ? state.info.uninstallDir : state.info.installDir;
  ui.installDir.value = state.target;
  ui.railVersion.textContent = `v${state.info.version}`;
  ui.footerNote.textContent = `SallyLauncher Setup · v${state.info.version}`;

  if (state.info.uninstall) {
    document.body.classList.add('uninstall');
    ui.railEdition.textContent = 'Deinstallation';
    ui.railStep1.textContent = 'Bestätigen';
    ui.railStep2.textContent = 'Entfernen';
    ui.railStep3.textContent = 'Fertig';
    ui.paneEyebrow.textContent = 'Deinstallation';
    ui.welcomeTitle.textContent = 'SallyLauncher deinstallieren';
    ui.welcomeSub.textContent =
      'Der Launcher wird von diesem PC entfernt. Verknüpfungen und der Eintrag unter „Apps & Features“ verschwinden mit.';
    setStageLabels(['Verknüpfungen', 'Daten', 'Dateien']);
    ui.uninstallWarning.classList.remove('hidden');
    ui.uninstallPath.textContent = state.info.uninstallDir;
    ui.installDir.closest('.field').classList.add('hidden');
    ui.primary.textContent = 'Deinstallieren';
    ui.primary.classList.add('danger');
    ui.secondary.textContent = 'Abbrechen';
    ui.secondary.classList.remove('hidden');
  } else {
    const size = sizeLabel(state.info.estimatedSpaceBytes);
    ui.dirHint.textContent = size
      ? `Standard: dein Benutzerprofil – keine Admin-Rechte nötig · temporär und installiert zusammen ca. ${size}`
      : 'Standard: dein Benutzerprofil – keine Admin-Rechte nötig.';
  }

  showStep('welcome');
}

setup.onEvent(({ type, payload }) => {
  if (type === 'progress') onProgress(payload);
});

boot().catch((err) => fail(err.message));
