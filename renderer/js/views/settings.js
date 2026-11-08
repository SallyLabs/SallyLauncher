import { el, icon, switchToggle, formatMb, themeReveal } from '../ui.js';
import { panels as accountPanels } from './accounts.js';

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'accounts', label: 'Accounts', icon: 'user' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'updates', label: 'Updates', icon: 'refresh' },
  { id: 'about', label: 'About', icon: 'sparkles' }
];

const SECTION_SUB = {
  general: 'Game, Java, performance and launch behaviour – everything applies to the next launch.',
  accounts: 'Minecraft accounts SallyLauncher can sign in with. Launches use the active one.',
  appearance: 'How the launcher looks.',
  updates: 'Release checks against GitHub.',
  about: 'Version info and links.'
};

function sectionTabs(ctx, section) {
  return el(
    'div',
    { class: 'settings-tabs' },
    ...SECTIONS.map((entry) =>
      el(
        'button',
        {
          class: `settings-tab${entry.id === section ? ' active' : ''}`,
          type: 'button',
          onclick: () => {
            if (entry.id === section) return;
            ctx.state.settingsTab = entry.id;
            ctx.refreshView();
          }
        },
        icon(entry.icon, 16),
        el('span', { text: entry.label })
      )
    )
  );
}

function row(label, hint, ...controls) {
  return el(
    'div',
    { class: 'setting' },
    el('div', {}, el('div', { class: 'setting-label', text: label }), hint ? el('div', { class: 'setting-hint', text: hint }) : null),
    el('div', { class: 'setting-control' }, ...controls)
  );
}

function panel(title, iconName, ...children) {
  return el(
    'div',
    { class: 'panel' },
    el('div', { class: 'panel-head' }, el('span', { class: 'ic' }, icon(iconName, 20)), el('span', { text: title })),
    ...children
  );
}

function updatesPanel(ctx) {
  const panel = el('section', { class: 'panel' });
  let busy = false;

  const paint = () => {
    const info = ctx.state.data.update || {};
    panel.innerHTML = '';
    const refresh = el(
      'button',
      {
        class: 'btn',
        type: 'button',
        disabled: busy,
        title: 'Ask GitHub for the newest release',
        onclick: async () => {
          if (busy) return;
          busy = true;
          paint();
          try {
            const result = await ctx.api.invoke('updates:check');
            if (result?.error) ctx.toast(result.error, 'error');
            else if (result?.available) ctx.toast(`SallyLauncher ${result.latestVersion} is available.`, 'success');
            else ctx.toast('You already run the newest release.', 'success');
          } catch (err) {
            ctx.toast(err.message, 'error');
          } finally {
            busy = false;
            await ctx.refresh();
          }
        }
      },
      busy ? el('span', { class: 'spinner' }) : icon('refresh', 16),
      el('span', { text: busy ? 'Checking…' : 'Check for updates' })
    );

    const badge = info.available
      ? el('span', { class: 'tag green', text: `v${info.latestVersion} available` })
      : info.error && info.noRelease
        ? el('span', { class: 'tag', text: 'Release not reachable' })
        : info.noRelease
          ? el('span', { class: 'tag', text: 'No release yet' })
          : info.error
            ? el('span', { class: 'tag', text: 'Check failed' })
            : el('span', { class: 'tag', text: info.checkedAt ? 'Up to date' : 'Not checked yet' });

    panel.append(
      el(
        'div',
        { class: 'panel-head' },
        el('span', { class: 'ic' }, icon('refresh', 20)),
        el('span', { text: 'Updates' }),
        el('span', { class: 'spacer' }),
        badge
      ),
      el(
        'div',
        { class: 'setting' },
        el(
          'div',
          {},
          el('div', { class: 'setting-label', text: 'SallyLauncher' }),
          el('div', {
            class: 'setting-hint',
            text: info.error
              ? info.error
              : info.noRelease
                ? `No release on github.com/${info.repo || 'SallyLabs/SallyLauncher'} yet – the update bar stays hidden until the first release with a .exe asset exists.`
                : info.available
                ? `Version ${info.latestVersion} is ready on GitHub – you run ${info.currentVersion}.`
                : `You run v${ctx.state.data.appVersion} – checks github.com/${info.repo || 'SallyLabs/SallyLauncher'} on every start.`
          })
        ),
        el(
          'div',
          { class: 'setting-control' },
          refresh,
          el(
            'button',
            { class: 'btn ghost', type: 'button', onclick: () => ctx.api.invoke('updates:openRelease', info.htmlUrl) },
            icon('external', 16),
            el('span', { text: 'Releases' })
          )
        )
      )
    );

    if (info.available) {
      panel.append(
        info.notes
          ? el('pre', { class: 'update-notes', text: info.notes })
          : el('div', { class: 'faint', style: { padding: '0 2px 12px' }, text: 'This release has no notes.' }),
        el(
          'div',
          { class: 'update-install' },
          el(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onclick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  const result = await ctx.api.invoke('updates:install');
                  ctx.toast(
                    result?.opened
                      ? 'This release has no in-place update – the release page opens instead.'
                      : result?.installer
                        ? 'Setup downloaded – the installer starts and updates SallyLauncher.'
                        : 'Update is being installed. SallyLauncher restarts, running games stay open.',
                    result?.opened ? 'info' : 'success'
                  );
                } catch (err) {
                  button.disabled = false;
                  ctx.toast(err.message, 'error');
                }
              }
            },
            icon('download', 17),
            el('span', { text: info.patch ? 'Install update' : info.asset ? 'Download installer' : 'Open release page' })
          ),
          el('span', {
            class: 'faint small',
            text: info.patch
              ? `Replaces only ${info.patch.name} (${Math.max(1, Math.round((info.patch.size || 0) / 1048576))} MB) – nothing is reinstalled.`
              : info.asset
                ? 'No in-place update attached – the full setup is downloaded and started instead.'
                : 'No download attached – the release page opens instead.'
          })
        )
      );
    }
  };

  paint();
  return panel;
}

export function render(root, ctx) {
  const settings = ctx.state.data.settings;
  const save = (patch) => ctx.saveSettings(patch);
  const section = SECTION_SUB[ctx.state.settingsTab] ? ctx.state.settingsTab : 'general';
  const data = ctx.state.data;

  /* game folder */
  const gameDirInput = el('input', { type: 'text', value: settings.gameDir, spellcheck: false });
  gameDirInput.addEventListener('change', () => save({ gameDir: gameDirInput.value.trim() }));
  const browse = el(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        const folder = await ctx.api.invoke('system:pickFolder', gameDirInput.value);
        if (folder) {
          gameDirInput.value = folder;
          await save({ gameDir: folder });
          ctx.loadVersions(true);
        }
      }
    },
    icon('folder', 16),
    el('span', { text: 'Browse' })
  );

  /* java */
  const javaInput = el('input', { type: 'text', value: settings.javaPath, placeholder: 'Auto-detect', spellcheck: false });
  javaInput.addEventListener('change', () => save({ javaPath: javaInput.value.trim() }));
  const javaStatus = el('span', { class: 'faint', text: 'Detecting…' });
  const detectJava = async () => {
    javaStatus.textContent = 'Detecting…';
    try {
      const info = await ctx.api.invoke('java:detect');
      javaStatus.textContent = info ? `Java ${info.version}` : 'No runtime found';
      javaStatus.title = info?.path || '';
    } catch (err) {
      javaStatus.textContent = err.message;
    }
  };
  detectJava();

  const javaPick = el(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        const file = await ctx.api.invoke('system:pickFile', { defaultPath: javaInput.value || settings.gameDir });
        if (file) {
          javaInput.value = file;
          await save({ javaPath: file });
          detectJava();
        }
      }
    },
    el('span', { text: 'Choose file' })
  );

  /* memory */
  const memoryValue = el('span', { class: 'range-value', text: formatMb(settings.memoryMb) });
  const memory = el('input', { type: 'range', min: 1024, max: 16384, step: 512, value: settings.memoryMb });
  memory.addEventListener('input', () => {
    memoryValue.textContent = formatMb(Number(memory.value));
  });
  memory.addEventListener('change', () => save({ memoryMb: Number(memory.value) }));

  const jvmInput = el('input', { type: 'text', value: settings.jvmArgs, placeholder: 'Extra JVM flags, e.g. -XX:+UseG1GC', spellcheck: false });
  jvmInput.addEventListener('change', () => save({ jvmArgs: jvmInput.value.trim() }));

  /* display */
  const fullscreenSwitch = switchToggle(settings.fullscreen, (value) => save({ fullscreen: value }));

  const width = el('input', { type: 'number', value: settings.resolutionWidth, min: 320, max: 7680, disabled: !settings.customResolution });
  const height = el('input', { type: 'number', value: settings.resolutionHeight, min: 240, max: 4320, disabled: !settings.customResolution });
  width.addEventListener('change', () => save({ resolutionWidth: Number(width.value) }));
  height.addEventListener('change', () => save({ resolutionHeight: Number(height.value) }));

  const resolutionSwitch = switchToggle(settings.customResolution, (value) => {
    width.disabled = !value;
    height.disabled = !value;
    save({ customResolution: value });
  });

  /* Escape hatch for machines whose GPU driver stalls while the launcher is
     open: Chromium can run the whole window on the CPU instead. */
  const gpuSwitch = switchToggle(settings.hardwareAcceleration !== false, async (value) => {
    await save({ hardwareAcceleration: value });
    ctx.toast(
      value
        ? 'Hardware acceleration on – restart SallyLauncher to apply.'
        : 'Hardware acceleration off – restart SallyLauncher to apply.',
      'info'
    );
  });

  /* launch */
  const serverInput = el('input', { type: 'text', value: settings.serverAddress, placeholder: 'play.example.net:25565', spellcheck: false });
  serverInput.addEventListener('change', () => save({ serverAddress: serverInput.value.trim() }));
  const connectSwitch = switchToggle(settings.autoConnect, (value) => save({ autoConnect: value }));
  const consoleSwitch = switchToggle(settings.showConsole, (value) => save({ showConsole: value }));
  const demoSwitch = switchToggle(settings.demoMode, (value) => save({ demoMode: value }));

  /* discord rich presence – the application ID ships in .env, users only
     flip the switch on or off */
  const discord = ctx.state.data.discord || {};
  const discordStatusText = el('span');
  const discordDot = el('span', { class: 'dot wait' });
  const paintDiscord = (state) => {
    const st = state || ctx.state.data.discord || {};
    const current = ctx.state.data.settings;
    const label = !current.discordRpc
      ? 'Off – not shown in Discord'
      : st.status === 'ready'
        ? `Connected${st.activity ? ` · ${st.activity}` : ''}`
        : st.status === 'connecting'
          ? 'Connecting…'
          : st.error || 'Waiting for Discord';
    discordStatusText.textContent = label;
    discordDot.className = `dot ${st.status === 'ready' && current.discordRpc ? 'ok' : 'wait'}`;
    discordDot.title = label;
  };
  paintDiscord(discord);

  const reconnectDiscord = async () => {
    discordStatusText.textContent = 'Connecting…';
    const state = await ctx.api.invoke('discord:reconnect');
    ctx.state.data.discord = state;
    paintDiscord(state);
    return state;
  };
  const discordSwitch = switchToggle(settings.discordRpc, async (value) => {
    await save({ discordRpc: value });
    const state = await reconnectDiscord();
    if (!value) ctx.toast('Discord Rich Presence disabled.', 'info');
    else if (state.status === 'ready') ctx.toast('Discord Rich Presence connected.', 'success');
    else if (state.error) ctx.toast(state.error, 'error');
  });

  /* theme */
  const themeTabs = el(
    'div',
    { class: 'toolbar', style: { marginBottom: '0' } },
    ...['dark', 'light'].map((value) =>
      el('button', {
        class: `tab${settings.theme === value ? ' active' : ''}`,
        type: 'button',
        text: value === 'dark' ? 'Dark' : 'Light',
        onclick: async (event) => {
          /* currentTarget is null after an await, so read everything up front */
          const button = event.currentTarget;
          const tabs = button.parentElement;
          const rect = button.getBoundingClientRect();
          themeReveal({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, () => {
            document.documentElement.dataset.theme = value;
          });
          tabs.querySelectorAll('.tab').forEach((node) => node.classList.remove('active'));
          button.classList.add('active');
          await save({ theme: value });
        }
      })
    )
  );

  const panels = {
    general: [
      panel(
        'Game',
        'cube',
        row(
          'Instances folder',
          'SallyLauncher keeps every profile in its own folder here. Minecraft files are shared from the launcher cache – your vanilla .minecraft stays untouched.',
          gameDirInput,
          browse,
          el('button', { class: 'btn', type: 'button', title: 'Open folder', onclick: () => ctx.openPath(gameDirInput.value) }, icon('external', 16))
        )
      ),
      panel(
        'Java',
        'cpu',
        row(
          'Java runtime',
          'Leave empty to auto-detect. Minecraft 1.21+ needs Java 21 or newer.',
          javaInput,
          javaPick,
          el('button', { class: 'btn', type: 'button', title: 'Detect again', onclick: detectJava }, icon('refresh', 16))
        ),
        row('Detected runtime', null, javaStatus)
      ),
      panel(
        'Performance',
        'memory',
        row('Memory allocation', `Minecraft can use up to ${formatMb(settings.memoryMb)} of RAM.`, memory, memoryValue),
        row('JVM arguments', 'Added after the memory flags.', jvmInput)
      ),
      panel(
        'Display',
        'monitor',
        row('Fullscreen', 'Start the game without a window border.', fullscreenSwitch),
        row(
          'Custom resolution',
          'Force a window size instead of letting Minecraft decide.',
          resolutionSwitch,
          width,
          el('span', { class: 'faint', text: '×' }),
          height
        ),
        row(
          'Hardware acceleration',
          'Turn this off if your graphics driver stalls while the launcher is open – the window then renders on the CPU. Restart to apply.',
          gpuSwitch
        )
      ),
      panel(
        'Launch',
        'bolt',
        row('Auto-connect', 'Join this server right after startup.', connectSwitch, serverInput),
        row('Live console', 'Open the Logs page when a launch starts.', consoleSwitch),
        row('Demo mode', 'Boot into the demo world.', demoSwitch)
      ),
      panel(
        'Discord',
        'gamepad',
        row(
          'Rich Presence',
          'Shows activity on your Discord profile while using SallyLauncher. Works when Discord is open.',
          el('span', { class: 'faint small' }, discordDot, discordStatusText),
          discordSwitch
        )
      )
    ],
    accounts: accountPanels(ctx),
    appearance: [panel('Appearance', 'sun', row('Theme', null, themeTabs))],
    updates: [updatesPanel(ctx)],
    about: [
      panel(
        'About',
        'sparkles',
        row('SallyLauncher', null, el('span', { class: 'faint', text: `v${data.appVersion}` })),
        row('Selected version', null, el('span', { class: 'faint', text: data.selectedVersion || '—' })),
        row(
          'Active account',
          'Switch or add accounts in the Accounts section.',
          el('span', { class: 'faint', text: data.activeAccount?.name || '—' }),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                ctx.state.settingsTab = 'accounts';
                ctx.refreshView();
              }
            },
            icon('user', 16),
            el('span', { text: 'Manage accounts' })
          )
        ),
        el(
          'div',
          { class: 'setting' },
          el('div', { class: 'setting-label', text: 'Minecraft' }),
          el('a', { class: 'btn', href: 'https://www.minecraft.net/', target: '_blank', rel: 'noreferrer' }, icon('external', 16), el('span', { text: 'minecraft.net' }))
        )
      )
    ]
  };

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: 'Settings' }),
        el('div', { class: 'page-sub', text: SECTION_SUB[section] })
      )
    ),
    sectionTabs(ctx, section),
    ...(panels[section] || panels.general)
  );
}


