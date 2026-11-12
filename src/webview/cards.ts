/**
 * Accounts panel, Quick Pick style: a filter box, "in use" / "other accounts" separators,
 * two-line rows, and an inline details panel under the clicked account.
 */
import type { CardCommand, CardLimit, CardProfile, CardsState, CliHealth, FromWebview, ToWebview } from '../model';

interface ViewState {
  open?: string;
  filter?: string;
}

declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): ViewState | undefined;
  setState(s: ViewState): void;
};

const api = acquireVsCodeApi();
const saved = api.getState() ?? {};
let openId: string | undefined = saved.open;
let filter = saved.filter ?? '';
let current: CardsState | undefined;

const save = () => api.setState({ open: openId, filter });

// ───────────────────────── DOM helpers ─────────────────────────

type Child = Node | string | false | null | undefined;

interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  focusKey?: string;
  onClick?: (e: MouseEvent) => void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.focusKey) el.dataset.focus = props.focusKey;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  if (props.onClick) {
    const onClick = props.onClick;
    el.addEventListener('click', (e) => onClick(e as MouseEvent));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c);
  return el;
}

const icon = (name: string, extra = ''): HTMLElement =>
  h('i', { class: `codicon codicon-${name}${extra ? ` ${extra}` : ''}`, attrs: { 'aria-hidden': 'true' } });

function run(command: CardCommand, profileId?: string): void {
  api.postMessage({ type: 'run', command, profileId });
}

/** Small icon button, like the action buttons on a Quick Pick row. */
function tool(iconName: string, label: string, onClick: () => void, focusKey?: string): HTMLButtonElement {
  return h(
    'button',
    {
      class: 'tool',
      title: label,
      focusKey,
      attrs: { type: 'button', 'aria-label': label },
      onClick: (e) => {
        e.stopPropagation();
        onClick();
      },
    },
    icon(iconName),
  );
}

const cmdTool = (iconName: string, label: string, command: CardCommand, p: CardProfile, extra = '') => {
  const el = tool(iconName, label, () => run(command, p.id), `${p.id}:${command}:tool`);
  if (extra) el.classList.add(extra);
  return el;
};

function button(label: string, iconName: string, command: CardCommand, p: CardProfile, kind: 'primary' | 'secondary' = 'primary'): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn ${kind}`,
      focusKey: `${p.id}:${command}:btn`,
      attrs: { type: 'button' },
      onClick: (e) => {
        e.stopPropagation();
        run(command, p.id);
      },
    },
    icon(iconName),
    h('span', { text: label }),
  );
}

function link(label: string, command: CardCommand, p: CardProfile, danger = false): HTMLButtonElement {
  return h('button', {
    class: `link${danger ? ' danger' : ''}`,
    text: label,
    focusKey: `${p.id}:${command}:link`,
    attrs: { type: 'button' },
    onClick: (e) => {
      e.stopPropagation();
      run(command, p.id);
    },
  });
}

// ───────────────────────── formatting ─────────────────────────

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** "Current week (all models)" → { name: "All models", period: "week" }. */
function splitLabel(label: string): { name: string; period: string } {
  const m = /^current\s+(\w+)(?:\s*\((.+)\))?\s*$/i.exec(label);
  if (!m) return { name: label, period: '' };
  const period = m[1].toLowerCase();
  if (period === 'session') return { name: 'Session', period: '' };
  const name = m[2] ? m[2].charAt(0).toUpperCase() + m[2].slice(1) : 'All models';
  return { name, period };
}

/** "Nov 12 at 11:59am (Asia/Saigon)" or "Nov 12, 12:00 PM" → "Nov 12". */
const shortDate = (s: string): string => s.split(/,| at /)[0].trim();

// ───────────────────────── pieces ─────────────────────────

function statusIcon(p: CardProfile): HTMLElement {
  if (p.busy && p.busy !== 'auth') return icon('loading', 'codicon-modifier-spin');
  if (p.queued) return icon('clock', 'muted');
  if (p.folderMissing) return icon('warning', 'warn');
  if (p.active) return icon('pass-filled', 'pass');
  if (p.loggedIn) return icon('account');
  return icon('circle-slash', 'muted');
}

function summary(p: CardProfile): Child[] {
  if (p.busy === 'usage' && !p.usage?.limits.length) return ['Checking quota…'];
  if (p.queued && !p.usage?.limits.length) return ['Quota check queued…'];
  if (p.busy === 'login') return ['Waiting for login in the terminal…'];
  if (p.busy === 'logout') return ['Logging out…'];
  if (p.folderMissing) return [h('span', { class: 'warn', text: 'Config folder is missing' })];
  if (!p.loggedIn) return ['Log in to use this account'];
  if (p.usageError) return [h('span', { class: 'crit', text: 'Quota check failed' })];
  const u = p.usage;
  if (!u) return ['Quota not checked yet'];
  if (!u.limits.length) return ['No subscription quota reported'];
  const out: Child[] = [];
  u.limits.forEach((l, i) => {
    if (i) out.push(' · ');
    out.push(`${splitLabel(l.label).name} ${l.percent}%`);
  });
  const reset = u.limits.find((l) => l.resets)?.resets;
  if (reset) out.push(` · resets ${shortDate(reset)}`);
  return out;
}

function rowTools(p: CardProfile): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (p.loggedIn && !p.active) out.push(cmdTool('arrow-swap', 'Switch to this account', 'switch', p));
  if (p.loggedIn) out.push(cmdTool('refresh', 'Check quota', 'checkQuota', p));
  else out.push(cmdTool('sign-in', 'Log in', 'login', p));
  out.push(cmdTool('folder-opened', 'Reveal config folder', 'revealFolder', p));
  return out;
}

function meter(pct: number): HTMLElement {
  const fill = h('i', { class: 'fill' });
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return h(
    'span',
    { class: 'meter', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) } },
    fill,
  );
}

function limitBlock(l: CardLimit, showReset: boolean): HTMLElement {
  const { name, period } = splitLabel(l.label);
  return h(
    'div',
    { class: 'limit', title: `${l.label}: ${l.percent}% used${l.resets ? `, resets ${l.resets}` : ''}` },
    h(
      'div',
      { class: 'limit-top' },
      h('span', {}, name, period ? h('span', { class: 'muted', text: ` · ${period}` }) : null),
      h('span', { class: 'pct', text: `${l.percent}%` }),
    ),
    meter(l.percent),
    showReset && l.resets ? h('div', { class: 'muted small', text: `Resets ${l.resets}` }) : null,
  );
}

function field(label: string, value: Child, opts: { title?: string; mono?: boolean } = {}, ...tools: Child[]): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-k', text: label }),
    h('span', { class: `field-v${opts.mono ? ' mono' : ''}`, title: opts.title }, value),
    h('span', { class: 'field-tools' }, ...tools),
  );
}

function details(p: CardProfile): HTMLElement {
  const parts: Child[] = [];

  if (p.loggedIn && p.usage?.limits.length) {
    const resets = new Set(p.usage.limits.map((l) => l.resets ?? ''));
    const shared = resets.size === 1 ? p.usage.limits[0].resets : undefined;
    parts.push(
      h(
        'div',
        { class: 'limits' },
        ...p.usage.limits.map((l) => limitBlock(l, !shared)),
        h(
          'div',
          { class: 'muted small' },
          shared ? `Resets ${shared} · updated ` : 'Updated ',
          h('span', { text: ago(p.usage.fetchedAt), attrs: { 'data-ts': String(p.usage.fetchedAt) } }),
        ),
      ),
    );
  } else if (p.loggedIn && p.usage) {
    parts.push(h('div', { class: 'muted small', text: 'No subscription quota reported for this account.' }));
  }
  if (p.usageError) parts.push(h('div', { class: 'crit small', text: `Quota check failed: ${p.usageError}` }));
  if (!p.loggedIn && p.authError) parts.push(h('div', { class: 'muted small', text: p.authError }));

  const fields: Child[] = [];
  if (p.loggedIn && (p.plan || p.org)) fields.push(field('Plan', [p.plan, p.org].filter(Boolean).join(' · ')));
  fields.push(
    field(
      'Folder',
      p.configDirShort,
      { title: p.isDefault ? `${p.configDir} (CLAUDE_CONFIG_DIR unset)` : `CLAUDE_CONFIG_DIR=${p.configDir}`, mono: true },
      cmdTool('copy', 'Copy path', 'copyPath', p),
      cmdTool('folder-opened', 'Reveal in file manager', 'revealFolder', p),
    ),
  );
  fields.push(field('Key', `${p.key.label}${p.key.present ? '' : ' (none)'}`, { title: p.key.detail }, cmdTool('go-to-file', 'Show key location', 'revealCredentials', p)));
  const s = p.sharing;
  if (s.state === 'shared') fields.push(field('Data', `Shared with ~/.claude (${s.linked} items)`));
  else if (s.state === 'source') fields.push(field('Data', 'Source shared by all accounts'));
  else if (s.state === 'disabled') fields.push(field('Data', 'Separate (sharing is off)'));
  else if (s.state === 'separate') {
    fields.push(field('Data', h('span', { class: 'warn', text: `Separate: ${s.separate.join(', ')}` }), {}, link('Unify', 'unifyShared', p)));
  }
  parts.push(h('div', { class: 'fields' }, ...fields));

  const primary = !p.loggedIn
    ? button('Log In', 'sign-in', 'login', p)
    : !p.active
      ? button('Switch', 'arrow-swap', 'switch', p)
      : !p.isDefault
        ? button('Unlink', 'debug-disconnect', 'unlink', p, 'secondary')
        : null;
  if (primary) parts.push(h('div', { class: 'buttons' }, primary));

  parts.push(
    h(
      'div',
      { class: 'toolbar', attrs: { role: 'toolbar', 'aria-label': `${p.name} actions` } },
      p.loggedIn ? cmdTool('refresh', 'Check quota', 'checkQuota', p) : null,
      cmdTool('sparkle', 'Start Claude in a terminal', 'startClaude', p),
      cmdTool('terminal', 'Open a terminal as this account', 'openTerminal', p),
      p.usage?.hasRaw ? cmdTool('output', 'Show full /usage output', 'showUsageDetails', p) : null,
      cmdTool('edit', 'Rename', 'rename', p),
      p.loggedIn ? cmdTool('sign-out', 'Log out', 'logout', p) : null,
      p.isDefault ? null : cmdTool('trash', 'Remove account', 'remove', p, 'danger'),
    ),
  );

  return h('div', { class: 'details', attrs: { id: `d-${p.id}`, role: 'region', 'aria-label': `${p.name} details` } }, ...parts);
}

function toggle(id: string): void {
  openId = openId === id ? undefined : id;
  save();
  renderList();
}

function row(p: CardProfile): HTMLElement[] {
  const open = openId === p.id;
  const el = h(
    'div',
    {
      class: ['qp-row', open ? 'open' : '', p.active ? 'active' : ''].filter(Boolean).join(' '),
      focusKey: `row:${p.id}`,
      attrs: { role: 'button', tabindex: '0', 'aria-expanded': String(open), 'aria-controls': `d-${p.id}` },
      onClick: () => toggle(p.id),
    },
    statusIcon(p),
    h(
      'div',
      { class: 'qp-main' },
      h(
        'div',
        { class: 'qp-l1' },
        h('span', { class: 'qp-name', text: p.name }),
        h('span', { class: 'qp-desc', text: !p.loggedIn ? 'not logged in' : p.email && p.email !== p.name ? p.email : (p.plan ?? '') }),
      ),
      h('div', { class: 'qp-l2' }, ...summary(p)),
    ),
    h('div', { class: 'qp-tools' }, ...rowTools(p)),
    icon('chevron-down', 'qp-chev'),
  );
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(p.id);
    }
  });
  return open ? [el, details(p)] : [el];
}

function separator(label: string, first: boolean): HTMLElement {
  return h('div', { class: `qp-sep${first ? ' first' : ''}`, text: label, attrs: { role: 'presentation' } });
}

function cliRow(health: CliHealth): HTMLElement {
  const missing = health === 'missing';
  const el = h(
    'div',
    { class: 'qp-row notice', focusKey: 'row:cli', attrs: { role: 'button', tabindex: '0' }, onClick: () => run('installCli') },
    icon('warning', 'warn'),
    h(
      'div',
      { class: 'qp-main' },
      h('div', { class: 'qp-l1' }, h('span', { class: 'qp-name', text: missing ? 'Claude Code CLI not found' : 'Claude Code CLI is outdated' })),
      h('div', { class: 'qp-l2', text: missing ? 'Needed to log in and check quota. Click to install.' : 'It has no `claude auth` command. Click to update.' }),
    ),
  );
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      run('installCli');
    }
  });
  return el;
}

function addRow(): HTMLElement {
  const el = h(
    'div',
    { class: 'qp-row action', focusKey: 'row:add', attrs: { role: 'button', tabindex: '0' }, onClick: () => run('addAccount') },
    icon('person-add'),
    h('div', { class: 'qp-main' }, h('div', { class: 'qp-l1' }, h('span', { class: 'qp-name', text: 'Add Account…' }))),
  );
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      run('addAccount');
    }
  });
  return el;
}

// ───────────────────────── shell (built once) ─────────────────────────

const root = document.getElementById('root') as HTMLElement;
const input = h('input', {
  attrs: { id: 'filter', type: 'text', placeholder: 'Filter accounts', 'aria-label': 'Filter accounts', spellcheck: 'false', autocomplete: 'off' },
});
input.value = filter;
const clearBtn = tool('close', 'Clear filter', () => {
  input.value = '';
  filter = '';
  save();
  renderList();
  input.focus();
});
const list = h('div', { class: 'qp-list' });
root.append(h('div', { class: 'qp' }, h('label', { class: 'qp-input' }, icon('search'), input, clearBtn), list));

input.addEventListener('input', () => {
  filter = input.value;
  save();
  renderList();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    list.querySelector<HTMLElement>('.qp-row')?.focus();
  } else if (e.key === 'Escape' && input.value) {
    clearBtn.click();
  }
});
list.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...list.querySelectorAll<HTMLElement>('.qp-row')];
  const i = rows.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  if (e.key === 'ArrowDown') rows[Math.min(rows.length - 1, i + 1)].focus();
  else if (i === 0) input.focus();
  else rows[i - 1].focus();
});

function renderList(): void {
  if (!current) return;
  clearBtn.hidden = !filter;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  const q = filter.trim().toLowerCase();
  const match = (p: CardProfile) => !q || [p.name, p.email, p.plan, p.org].some((s) => s?.toLowerCase().includes(q));
  const active = current.profiles.filter((p) => p.active && match(p));
  const others = current.profiles.filter((p) => !p.active && match(p));

  const nodes: Node[] = [];
  if (current.cli !== 'ok') nodes.push(cliRow(current.cli));
  if (active.length) {
    nodes.push(separator('in use', nodes.length === 0));
    for (const p of active) nodes.push(...row(p));
  }
  if (others.length) {
    nodes.push(separator('other accounts', nodes.length === 0));
    for (const p of others) nodes.push(...row(p));
  }
  if (!active.length && !others.length) nodes.push(h('div', { class: 'qp-empty', text: `No account matches “${filter.trim()}”.` }));
  nodes.push(h('div', { class: 'qp-sep spacer' }), addRow());
  list.replaceChildren(...nodes);
  if (focused) list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  if (e.data?.type !== 'state') return;
  current = e.data.state;
  if (openId && !current.profiles.some((p) => p.id === openId)) openId = undefined;
  renderList();
});

setInterval(() => {
  for (const el of list.querySelectorAll<HTMLElement>('[data-ts]')) el.textContent = ago(Number(el.dataset.ts));
}, 30_000);

api.postMessage({ type: 'ready' });
