import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Activator, CLAUDE_CODE_EXTENSION_ID, claudeCodeConfigDir } from './activation';
import { CARDS_VIEW_ID, CardsViewProvider } from './cardsView';
import * as cli from './claude';
import { removeLinks, seedGlobalConfig, syncLinks, unifyWithShared } from './links';
import { SpacedQueue } from './queue';
import { claudeCodeChats } from './sessions';
import { DEFAULT_CONFIG_DIR, DEFAULT_ID, Profile, ProfileStore } from './store';
import { createAccountTerminal } from './terminal';
import { AccountsTree, CliHealth, emailOf, isLoggedIn, planOf, ProfileState, profileTooltip, TreeHost, TreeNode } from './tree';
import { canonicalDir, errorText, isDirectory, tildify } from './util';

const USAGE_KEY = 'claudeSwitch.usage';
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** First background quota scan after start-up, and retry step while the window is not focused. */
const AUTO_QUOTA_MIN_DELAY_MS = 30_000;
const AUTO_QUOTA_RETRY_MS = 60_000;
const VIEW_ID = 'claudeSwitch.accounts';
const cfg = () => vscode.workspace.getConfiguration('claudeSwitch');

type CommandArg = TreeNode | { kind: 'detail'; profileId: string } | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const controller = new Controller(ctx);
  ctx.subscriptions.push(controller);
  void controller.init();
}

export function deactivate(): void {
  /* nothing: the env collection is persistent on purpose */
}

class Controller implements TreeHost, vscode.Disposable {
  readonly store: ProfileStore;
  private readonly log = vscode.window.createOutputChannel('Claude Account Switch');
  private readonly states = new Map<string, ProfileState>();
  private readonly tree: AccountsTree;
  private readonly view: vscode.TreeView<TreeNode>;
  private readonly status: vscode.StatusBarItem;
  private readonly activator: Activator;
  private readonly cards: CardsViewProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly loginWatches = new Map<string, () => void>();
  private binCache: string | null | undefined;
  private waitingForIdle = false;
  /** CLAUDE_CONFIG_DIR last applied in this window ('' = default). */
  private lastAppliedDir: string | undefined;
  private autoTimer: NodeJS.Timeout | undefined;
  private lastAutoScanAt = 0;
  private lastAutoScanEndAt = 0;
  private disposed = false;
  /** Every `/usage` goes through here: one at a time, with a gap, so several accounts do not hit the API at once. */
  private readonly quota = new SpacedQueue<string>({
    run: (id, quiet) => this.runUsage(id, quiet),
    spacingMs: () => Math.max(0, cfg().get<number>('quotaCheckSpacingSeconds', 10)) * 1000,
    onChange: () => {
      for (const p of this.store.all()) this.stateOf(p.id).queued = this.quota.has(p.id);
      this.render();
    },
  });

  constructor(private readonly ctx: vscode.ExtensionContext) {
    // CLAUDE_SWITCH_ROOT: used by the sandbox launch config (and handy for tests).
    this.store = new ProfileStore(process.env.CLAUDE_SWITCH_ROOT || cfg().get<string>('profilesRoot') || '~/.claude-switch');
    this.tree = new AccountsTree(this);
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this.tree, showCollapseAll: true });
    this.status = vscode.window.createStatusBarItem('claudeSwitch.active', vscode.StatusBarAlignment.Right, 100);
    this.status.name = 'Claude Account';
    this.status.command = 'claudeSwitch.switch';
    this.activator = new Activator(ctx, this.store.root, this.log);
    this.cards = new CardsViewProvider(ctx.extensionUri, this);
    this.disposables.push(this.log, this.view, this.status, vscode.window.registerWebviewViewProvider(CARDS_VIEW_ID, this.cards));
    this.registerCommands();
    this.watch();
  }

  async init(): Promise<void> {
    this.restoreUsage();
    this.autoImport();
    await this.applyActive();
    this.render();
    await this.refreshAll();
    await this.cleanUpPending();
    this.scheduleAutoQuota();
    this.notifyCliHealth();
  }

  /** Pending accounts left over from a window that reloaded mid-login. */
  private async cleanUpPending(): Promise<void> {
    for (const p of this.store.all()) {
      if (!p.pending) continue;
      if (isLoggedIn(this.stateOf(p.id))) {
        this.store.confirm(p.id);
        continue;
      }
      const age = Date.now() - (p.createdAt ? Date.parse(p.createdAt) : 0);
      if (age > LOGIN_TIMEOUT_MS) await this.discardIfPending(p, 'The login did not complete', true);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.quota.dispose();
    for (const stop of [...this.loginWatches.values()]) stop();
    for (const d of this.disposables) d.dispose();
  }

  // ───────────────────────── TreeHost ─────────────────────────

  stateOf(id: string): ProfileState {
    let st = this.states.get(id);
    if (!st) {
      st = {};
      this.states.set(id, st);
    }
    return st;
  }

  shareEnabled(): boolean {
    return cfg().get<boolean>('shareData', true);
  }

  cliHealth(): CliHealth {
    if (!this.bin()) return 'missing';
    return cli.looksOutdated(this.states.get(DEFAULT_ID)?.auth) ? 'outdated' : 'ok';
  }

  private shareExclude(): string[] {
    return cfg().get<string[]>('shareExclude', []);
  }

  // ───────────────────────── core ─────────────────────────

  private bin(): string | undefined {
    if (this.binCache === undefined) {
      const ext = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
      const bundled = ext
        ? [path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude')]
        : [];
      this.binCache = cli.resolveClaudeBinary(cfg().get<string>('claudePath') ?? '', bundled) ?? null;
      this.log.appendLine(`[cli] claude binary: ${this.binCache ?? 'NOT FOUND'}`);
    }
    return this.binCache ?? undefined;
  }

  private requireBin(): string | undefined {
    const b = this.bin();
    if (!b) {
      void vscode.window
        .showErrorMessage('Claude Code CLI (`claude`) not found — it is needed for this action.', 'Install…')
        .then((a) => a && vscode.commands.executeCommand('claudeSwitch.installCli'));
    }
    return b;
  }

  /** One notification per window (until “Don't Show Again”); the warning row in the panel stays. */
  private notifyCliHealth(): void {
    const health = this.cliHealth();
    if (health === 'ok') return;
    const key = `claudeSwitch.hideCliNotice.${health}`;
    if (this.ctx.globalState.get<boolean>(key)) return;
    const msg =
      health === 'missing'
        ? 'Claude Account Switch: Claude Code CLI (`claude`) not found. It is needed to log in and check quota.'
        : 'Claude Account Switch: this Claude Code CLI has no `claude auth` command — please update it.';
    void vscode.window
      .showWarningMessage(msg, health === 'missing' ? 'Install…' : 'Update…', "Don't Show Again")
      .then((a) => {
        if (a === "Don't Show Again") void this.ctx.globalState.update(key, true);
        else if (a) void vscode.commands.executeCommand('claudeSwitch.installCli');
      });
  }

  /** Re-resolve the binary (after an install, a settings change, or when the window regains focus). */
  private async redetectCli(announce: boolean): Promise<void> {
    const before = this.binCache;
    this.binCache = undefined;
    const now = this.bin();
    if (now && now !== before) {
      if (before === null) void vscode.window.showInformationMessage(`Claude Code CLI found: ${tildify(now)}`);
      await this.refreshAll();
    } else if (!now && announce) {
      void vscode.window
        .showWarningMessage('Claude Code CLI still not found. If you installed it in a custom place, choose the executable.', 'Choose…')
        .then((a) => a && this.chooseCliPath());
    }
    this.render();
  }

  private async chooseCliPath(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Use this claude',
      title: 'Select the claude executable',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), '.local', 'bin')),
    });
    if (!uris?.length) return;
    await cfg().update('claudePath', uris[0].fsPath, vscode.ConfigurationTarget.Global);
    await this.redetectCli(true);
  }

  private async installCli(): Promise<void> {
    const health = this.cliHealth();
    const bin = this.bin();
    type Item = vscode.QuickPickItem & { run?: string; action?: 'docs' | 'path' | 'retry' };
    const items: Item[] = [];
    if (health === 'outdated' && bin) {
      const quoted = process.platform === 'win32' ? `& "${bin}" update` : `"${bin}" update`;
      items.push({ label: '$(sync) Update Claude Code', description: 'claude update', run: quoted });
    } else {
      for (const c of cli.installCommands()) items.push({ label: `$(cloud-download) ${c.label}`, description: c.command, run: c.command });
    }
    items.push(
      { label: '$(book) Open the official setup guide', description: cli.INSTALL_DOCS_URL, action: 'docs' },
      { label: '$(file-binary) Already installed — choose the executable…', action: 'path' },
      { label: '$(refresh) Detect again', action: 'retry' },
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: health === 'outdated' ? 'Update Claude Code CLI' : 'Install Claude Code CLI',
      placeHolder: 'The command is typed into a terminal for you to review — nothing runs until you press Enter',
    });
    if (!pick) return;
    if (pick.run) {
      const term = vscode.window.createTerminal({ name: 'Install Claude Code', iconPath: new vscode.ThemeIcon('cloud-download') });
      term.show();
      term.sendText(pick.run, false);
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (t !== term) return;
        sub.dispose();
        void this.redetectCli(false);
      });
      this.disposables.push(sub);
      void vscode.window.showInformationMessage('Review the command in the terminal and press Enter. The panel detects Claude Code by itself once it is installed.');
    } else if (pick.action === 'docs') {
      await vscode.env.openExternal(vscode.Uri.parse(cli.INSTALL_DOCS_URL));
    } else if (pick.action === 'path') {
      await this.chooseCliPath();
    } else if (pick.action === 'retry') {
      await this.redetectCli(true);
    }
  }

  /** First run: adopt a CLAUDE_CONFIG_DIR the user already had, so installing changes nothing. */
  private autoImport(): void {
    const firstRun = !this.store.exists;
    const candidates = [claudeCodeConfigDir(), process.env.CLAUDE_CONFIG_DIR].filter((d): d is string => !!d && !!d.trim());
    let imported: Profile | undefined;
    for (const dir of candidates) {
      if (canonicalDir(dir) === canonicalDir(DEFAULT_CONFIG_DIR) || this.store.findByDir(dir)) continue;
      const p = this.store.add(path.basename(dir).replace(/^\./, '') || 'Imported', dir, false);
      imported ??= p;
      this.log.appendLine(`[import] existing CLAUDE_CONFIG_DIR ${dir} → account “${p.name}”`);
    }
    if (firstRun && imported) this.store.setActive(imported.id);
  }

  private async applyActive(): Promise<void> {
    const p = this.store.active;
    if (!p.isDefault && this.shareEnabled() && isDirectory(p.configDir)) {
      this.stateOf(p.id).links = syncLinks(p.configDir, this.shareExclude(), true);
    }
    await this.activator.apply(p);
    this.lastAppliedDir = p.isDefault ? '' : p.configDir;
    this.render();
  }

  private render(): void {
    this.tree.refresh();
    this.cards.update();
    this.updateStatus();
    void vscode.commands.executeCommand('setContext', 'claudeSwitch.customActive', !this.store.active.isDefault);
  }

  private updateStatus(): void {
    if (!cfg().get<boolean>('showStatusBar', true)) {
      this.status.hide();
      return;
    }
    const p = this.store.active;
    const st = this.stateOf(p.id);
    const pct = cli.percentsText(st.usage);
    if (this.cliHealth() === 'missing') {
      this.status.text = `$(warning) ${p.name}`;
      this.status.tooltip = 'Claude Code CLI not found — click to install';
      this.status.command = 'claudeSwitch.installCli';
      this.status.show();
      return;
    }
    this.status.command = 'claudeSwitch.switch';
    this.status.text = `$(${st.busy ? 'loading~spin' : 'account'}) ${p.name}${pct ? ` ${pct}` : ''}`;
    const tip = profileTooltip(p, st, true);
    tip.appendMarkdown('\n\n---\n\nClick to switch Claude account');
    this.status.tooltip = tip;
    this.status.show();
  }

  private async refreshAll(): Promise<void> {
    const bin = this.bin();
    await Promise.all(this.store.all().map((p) => this.refreshProfile(p, bin)));
  }

  /** Re-read local metadata (cheap). With `bin`, also asks `claude auth status`. */
  private async refreshProfile(p: Profile, bin: string | undefined = this.bin()): Promise<void> {
    const st = this.stateOf(p.id);
    st.folderMissing = !p.isDefault && !isDirectory(p.configDir);
    this.readLocal(p, st);
    st.links = !p.isDefault && !st.folderMissing && this.shareEnabled() ? syncLinks(p.configDir, this.shareExclude(), true) : undefined;
    if (process.platform === 'darwin') {
      const service = cli.keychainService(p);
      st.keychain = { service, exists: await cli.keychainHasItem(service) };
    }
    if (bin && !st.folderMissing) st.auth = await cli.getAuthStatus(bin, p);
    if (p.pending && isLoggedIn(st)) this.store.confirm(p.id);
    this.applyAutoName(p, st);
    this.render();
  }

  /** Accounts added without a name take their login email as name, until renamed by hand. */
  private applyAutoName(p: Profile, st: ProfileState): void {
    const current = this.store.get(p.id);
    if (!current?.autoName) return;
    const email = isLoggedIn(st) ? emailOf(st) : undefined;
    if (!email || current.name === email) return;
    this.store.rename(p.id, this.store.uniqueName(email, p.id), { auto: true });
    this.log.appendLine(`[name] “${current.name}” → “${this.store.get(p.id)?.name}”`);
    if (this.store.active.id === p.id) void this.activator.apply(this.store.active);
  }

  private readLocal(p: Profile, st: ProfileState): void {
    st.meta = st.folderMissing ? undefined : cli.readAccountMeta(p);
    const cached = st.meta?.cachedUsage;
    // Claude Code refreshes this cache on its own while you work → free, up-to-date quota.
    if (cached?.limits.length && (!st.usage || cached.fetchedAt > st.usage.fetchedAt + 1000)) {
      st.usage = cached;
      this.saveUsage();
    }
  }

  /** Loads stored quota; keeps whatever is newer, so a check done in another window shows up here too. */
  private restoreUsage(): void {
    const map = this.ctx.globalState.get<Record<string, cli.UsageInfo>>(USAGE_KEY) ?? {};
    for (const p of this.store.all()) {
      const u = map[p.configDir];
      if (!u || !Array.isArray(u.limits)) continue;
      const st = this.stateOf(p.id);
      if (!st.usage || u.fetchedAt > st.usage.fetchedAt) st.usage = u;
    }
  }

  private saveUsage(): void {
    const stored = this.ctx.globalState.get<Record<string, cli.UsageInfo>>(USAGE_KEY) ?? {};
    const map: Record<string, cli.UsageInfo> = {};
    for (const p of this.store.all()) {
      const mine = this.states.get(p.id)?.usage;
      if (!mine) continue;
      const theirs = stored[p.configDir];
      const u = theirs && Array.isArray(theirs.limits) && theirs.fetchedAt > mine.fetchedAt ? theirs : mine;
      map[p.configDir] = { ...u, raw: u.raw?.slice(0, 20_000) };
    }
    void this.ctx.globalState.update(USAGE_KEY, map);
  }

  // ───────────────────────── background quota scan ─────────────────────────

  private autoQuotaIntervalMs(): number {
    return cfg().get<number>('quotaAutoRefreshMinutes', 5) * 60_000;
  }

  private autoQuotaEnabled(): boolean {
    return cfg().get<boolean>('quotaAutoRefresh', true) && this.autoQuotaIntervalMs() > 0;
  }

  private newestUsageAt(): number {
    let t = 0;
    for (const p of this.store.all()) t = Math.max(t, this.states.get(p.id)?.usage?.fetchedAt ?? 0);
    return t;
  }

  /**
   * (Re)arms the scan timer. Without `delayMs` the next scan is one interval after the last one
   * (or after the newest stored quota, right after start-up), at least AUTO_QUOTA_MIN_DELAY_MS away.
   */
  private scheduleAutoQuota(delayMs?: number): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
    if (this.disposed) return;
    if (!this.autoQuotaEnabled()) {
      this.quota.clear((quiet) => quiet); // a background scan still waiting in the queue stops here
      return;
    }
    const interval = Math.max(60_000, this.autoQuotaIntervalMs());
    const last = this.lastAutoScanAt || this.newestUsageAt();
    const ms = delayMs ?? Math.min(interval, Math.max(AUTO_QUOTA_MIN_DELAY_MS, last + interval - Date.now()));
    this.autoTimer = setTimeout(() => void this.autoQuotaTick(), ms);
  }

  /** One pass over every logged-in account, through the queue. Only the focused window scans. */
  private async autoQuotaTick(): Promise<void> {
    this.autoTimer = undefined;
    if (this.disposed || !this.autoQuotaEnabled()) return;
    if (!vscode.window.state.focused || !this.bin()) {
      this.scheduleAutoQuota(AUTO_QUOTA_RETRY_MS);
      return;
    }
    this.restoreUsage(); // another window may have scanned meanwhile
    // Skip what was checked after our previous scan (other window, manual check, Claude Code's
    // cache) and is still younger than half an interval. Our own previous pass never counts.
    const fresh = Math.max(this.lastAutoScanEndAt, Date.now() - this.autoQuotaIntervalMs() / 2);
    const targets = this.store.all().filter((p) => {
      const st = this.stateOf(p.id);
      return isLoggedIn(st) && (st.usage?.fetchedAt ?? 0) <= fresh;
    });
    this.lastAutoScanAt = Date.now();
    this.log.appendLine(`[usage] auto scan: ${targets.length ? targets.map((p) => p.name).join(', ') : 'everything is fresh'}`);
    try {
      if (targets.length) await this.quota.enqueue(this.activeFirst(targets).map((p) => p.id), { quiet: true });
    } finally {
      this.lastAutoScanEndAt = Date.now();
      this.scheduleAutoQuota();
    }
  }

  /** The account in use first: its quota matters most. */
  private activeFirst(list: Profile[]): Profile[] {
    const activeId = this.store.active.id;
    return [...list].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
  }

  private watch(): void {
    const file = this.store.registryFile;
    const onRegistryChange = () => {
      if (!this.store.reload()) return;
      this.log.appendLine('[registry] changed on disk — reloading');
      const before = this.lastAppliedDir;
      void this.applyActive()
        .then(() => this.refreshAll())
        .then(() => {
          // Another window switched accounts: move this window's open Claude Code chats too.
          if (this.lastAppliedDir !== before) void this.reopenClaudeCodeChats(this.store.active, false);
        });
    };
    fs.watchFile(file, { interval: 1500 }, onRegistryChange);
    this.disposables.push({ dispose: () => fs.unwatchFile(file, onRegistryChange) });

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeSwitch.claudePath')) void this.redetectCli(false);
        if (e.affectsConfiguration('claudeSwitch.profilesRoot')) {
          void vscode.window
            .showInformationMessage('Reload the window to use the new Claude profiles folder.', 'Reload Window')
            .then((a) => a && vscode.commands.executeCommand('workbench.action.reloadWindow'));
        }
        if (['applyToTerminals', 'syncClaudeCodeExtension', 'writeShellEnvFiles'].some((k) => e.affectsConfiguration(`claudeSwitch.${k}`))) {
          void this.applyActive();
        }
        if (e.affectsConfiguration('claudeSwitch.showStatusBar')) this.updateStatus();
        if (['quotaAutoRefresh', 'quotaAutoRefreshMinutes'].some((k) => e.affectsConfiguration(`claudeSwitch.${k}`))) {
          this.lastAutoScanAt = 0;
          this.scheduleAutoQuota();
        }
        if (e.affectsConfiguration('claudeSwitch.shareData') || e.affectsConfiguration('claudeSwitch.shareExclude')) {
          void this.refreshAll();
        }
      }),
      vscode.extensions.onDidChange(() => {
        this.binCache = undefined;
        void this.applyActive();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (!s.focused) return;
        if (this.binCache === null) void this.redetectCli(false); // installed while we were away?
        this.restoreUsage();
        for (const p of this.store.all()) this.readLocal(p, this.stateOf(p.id));
        this.render();
        if (this.autoTimer) this.scheduleAutoQuota(); // overdue while unfocused → scan soon
      }),
    );
  }

  // ───────────────────────── helpers ─────────────────────────

  private async target(arg: CommandArg, placeHolder: string, filter?: (p: Profile) => boolean): Promise<Profile | undefined> {
    if (arg && typeof arg === 'object') {
      if (arg.kind === 'profile') return this.store.get(arg.profile.id);
      if (arg.kind === 'detail') return this.store.get(arg.profileId);
    }
    return this.pick(placeHolder, filter);
  }

  private async pick(placeHolder: string, filter: (p: Profile) => boolean = () => true): Promise<Profile | undefined> {
    const activeId = this.store.active.id;
    const items = this.store
      .all()
      .filter(filter)
      .map((p) => {
        const st = this.stateOf(p.id);
        const pct = cli.percentsText(st.usage);
        const icon = p.id === activeId ? 'pass-filled' : isLoggedIn(st) ? 'account' : 'circle-slash';
        return {
          label: `$(${icon}) ${p.name}`,
          description: [
            emailOf(st) ?? (isLoggedIn(st) ? '' : 'not logged in'),
            planOf(st),
            pct ?? '',
            p.id === activeId ? 'active' : '',
          ]
            .filter(Boolean)
            .join(' · '),
          detail: tildify(p.configDir),
          profile: p,
        };
      });
    if (!items.length) {
      void vscode.window.showInformationMessage('No matching Claude account.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    return picked?.profile;
  }

  private askName(title: string, value = '', exceptId?: string): Thenable<string | undefined> {
    return vscode.window.showInputBox({
      title,
      value,
      placeHolder: 'e.g. Work, Personal, Client X',
      validateInput: (v) => {
        const n = v.trim();
        if (!n) return 'Required';
        if (n.length > 60) return 'Max 60 characters';
        if (this.store.nameTaken(n, exceptId)) return 'Another account already uses this name';
        return undefined;
      },
    });
  }

  private visibleViewId(): string {
    return cfg().get<string>('viewStyle', 'cards') === 'tree' ? VIEW_ID : CARDS_VIEW_ID;
  }

  private hasClaudeCodeExtension(): boolean {
    return !!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
  }

  // ───────────────────────── commands ─────────────────────────

  private registerCommands(): void {
    const reg = (id: string, fn: (arg: CommandArg) => unknown) =>
      this.disposables.push(
        vscode.commands.registerCommand(id, async (arg: CommandArg) => {
          try {
            await fn(arg);
          } catch (e) {
            this.log.appendLine(`[${id}] ${errorText(e)}`);
            void vscode.window.showErrorMessage(`Claude Account Switch: ${errorText(e)}`);
          }
        }),
      );

    reg('claudeSwitch.addAccount', () => this.addAccount());
    reg('claudeSwitch.refresh', () => this.refreshCommand());
    reg('claudeSwitch.checkAllQuota', () => this.checkAllQuota(false));
    reg('claudeSwitch.switch', async (a) => {
      const p = await this.target(a, 'Switch Claude account to…');
      if (p) await this.switchTo(p);
    });
    reg('claudeSwitch.unlink', () => this.unlink());
    reg('claudeSwitch.checkQuota', async (a) => {
      const p = await this.target(a, 'Check quota of…', (x) => isLoggedIn(this.stateOf(x.id)));
      if (p) await this.checkQuota(p, false);
    });
    reg('claudeSwitch.showUsageDetails', async (a) => {
      const p = await this.target(a, 'Show /usage of…', (x) => isLoggedIn(this.stateOf(x.id)));
      if (p) await this.showUsageDetails(p);
    });
    reg('claudeSwitch.login', async (a) => {
      const p = await this.target(a, 'Log in which account?');
      if (p) await this.login(p);
    });
    reg('claudeSwitch.logout', async (a) => {
      const p = await this.target(a, 'Log out which account?', (x) => isLoggedIn(this.stateOf(x.id)));
      if (p) await this.logout(p);
    });
    reg('claudeSwitch.startClaude', async (a) => {
      const p = await this.target(a, 'Start Claude as…');
      const bin = p && this.requireBin();
      if (p && bin) createAccountTerminal(p, { name: `Claude · ${p.name}`, command: { bin, args: [] } }).show();
    });
    reg('claudeSwitch.openTerminal', async (a) => {
      const p = await this.target(a, 'Open terminal as…');
      if (p) createAccountTerminal(p, { name: `Shell · ${p.name}` }).show();
    });
    reg('claudeSwitch.revealFolder', async (a) => {
      const p = await this.target(a, 'Reveal config folder of…');
      if (!p) return;
      if (!isDirectory(p.configDir)) {
        void vscode.window.showWarningMessage(`Folder does not exist yet: ${p.configDir}`);
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p.configDir));
    });
    reg('claudeSwitch.revealCredentials', async (a) => {
      const p = await this.target(a, 'Show key location of…');
      if (p) await this.revealCredentials(p);
    });
    reg('claudeSwitch.copyPath', async (a) => {
      const p = await this.target(a, 'Copy config folder path of…');
      if (!p) return;
      await vscode.env.clipboard.writeText(p.configDir);
      vscode.window.setStatusBarMessage(`$(copy) Copied ${tildify(p.configDir)}`, 2500);
    });
    reg('claudeSwitch.unifyShared', async (a) => {
      const p = await this.target(a, 'Unify sessions & memory of…', (x) => !x.isDefault);
      if (p) await this.unifyShared(p);
    });
    reg('claudeSwitch.rename', async (a) => {
      const p = await this.target(a, 'Rename which account?');
      if (!p) return;
      const name = await this.askName(`Rename “${p.name}”`, p.name, p.id);
      if (!name || name.trim() === p.name) return;
      this.store.rename(p.id, name);
      if (this.store.active.id === p.id) await this.applyActive();
      this.render();
    });
    reg('claudeSwitch.remove', async (a) => {
      const p = await this.target(a, 'Remove which account?', (x) => !x.isDefault);
      if (p) await this.remove(p);
    });
    reg('claudeSwitch.openRoot', async () => {
      fs.mkdirSync(this.store.root, { recursive: true, mode: 0o700 });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.store.registryFile));
    });
    reg('claudeSwitch.shellIntegration', () => this.shellIntegration());
    reg('claudeSwitch.installCli', () => this.installCli());
    reg('claudeSwitch.useTreeView', () => cfg().update('viewStyle', 'tree', vscode.ConfigurationTarget.Global));
    reg('claudeSwitch.useCardView', () => cfg().update('viewStyle', 'cards', vscode.ConfigurationTarget.Global));
  }

  private async refreshCommand(): Promise<void> {
    this.store.reload();
    this.binCache = undefined;
    await vscode.window.withProgress({ location: { viewId: this.visibleViewId() } }, async () => {
      await this.applyActive();
      await this.refreshAll();
    });
  }

  private async addAccount(): Promise<void> {
    type MethodItem = vscode.QuickPickItem & { args?: string[]; importFolder?: boolean };
    const method = await vscode.window.showQuickPick<MethodItem>(
      [
        {
          label: '$(sign-in) Claude account',
          description: 'Pro · Max · Team · Enterprise',
          detail: 'Runs the official `claude auth login` in a terminal',
          args: [],
        },
        { label: '$(key) Anthropic Console', description: 'API usage billing', args: ['--console'] },
        { label: '$(organization) SSO', description: 'Force the SSO login flow', args: ['--sso'] },
        {
          label: '$(folder-opened) Import existing folder…',
          description: 'A folder you already use as CLAUDE_CONFIG_DIR',
          importFolder: true,
        },
      ],
      { title: 'Add Claude Account', placeHolder: 'How do you want to add the account?' },
    );
    if (!method) return;
    if (method.importFolder) return this.importFolder();
    if (!this.requireBin()) return;

    // No name prompt: the account is named after its login email once logged in (rename any time).
    const dir = this.store.allocateManagedDir('account');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (cfg().get<boolean>('seedGlobalConfig', true)) seedGlobalConfig(dir);
    if (this.shareEnabled()) syncLinks(dir, this.shareExclude(), true);
    const p = this.store.add(this.store.uniqueName('New account'), dir, true, { autoName: true, pending: true });
    this.log.appendLine(`[add] “${p.name}” → ${dir}`);
    this.render();
    await this.refreshProfile(p);
    await this.login(p, method.args ?? [], true);
  }

  private async importFolder(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Import',
      title: 'Select a Claude config folder (CLAUDE_CONFIG_DIR)',
      defaultUri: vscode.Uri.file(os.homedir()),
    });
    if (!uris?.length) return;
    const dir = canonicalDir(uris[0].fsPath);
    if (dir === canonicalDir(DEFAULT_CONFIG_DIR)) {
      void vscode.window.showInformationMessage('That is the default ~/.claude folder — it is already listed as the default account.');
      return;
    }
    const existing = this.store.findByDir(dir);
    if (existing) {
      void vscode.window.showInformationMessage(`Already added as “${existing.name}”.`);
      return;
    }
    const p = this.store.add(this.store.uniqueName(path.basename(dir).replace(/^\./, '') || 'Imported'), dir, false, { autoName: true });
    this.render();
    await this.refreshProfile(p);
    const st = this.stateOf(p.id);
    if (isLoggedIn(st)) {
      void vscode.window.showInformationMessage(`Imported “${p.name}” (${emailOf(st) ?? 'logged in'}).`);
    } else {
      const a = await vscode.window.showInformationMessage(`Imported “${p.name}”. It is not logged in.`, 'Log In');
      if (a) await this.login(p);
    }
  }

  private async switchTo(p: Profile): Promise<void> {
    const prev = this.store.active;
    this.store.setActive(p.id);
    await this.applyActive();
    const st = this.stateOf(p.id);
    if (!isLoggedIn(st)) {
      const a = await vscode.window.showWarningMessage(`Claude: linked “${p.name}”, but it is not logged in.`, 'Log In');
      if (a) await this.login(p);
      return;
    }
    const who = emailOf(st) ? ` (${emailOf(st)})` : '';
    const head =
      prev.id === p.id
        ? `Claude: “${p.name}” is already active.`
        : p.isDefault
          ? `Claude: unlinked — back to default ~/.claude${who}.`
          : `Claude: switched to “${p.name}”${who}.`;
    const ext = this.hasClaudeCodeExtension() && cfg().get<boolean>('syncClaudeCodeExtension', true);
    void vscode.window.showInformationMessage(head + (ext ? ' New terminals and new Claude Code chats use it.' : ' New terminals use it.'));
    if (prev.id !== p.id) await this.reopenClaudeCodeChats(p, true);
  }

  /**
   * Chats already open in the Claude Code extension keep the account their process started with.
   * Reloading the window makes Claude Code reopen every tab with the same session, now on the new
   * account (sessions are shared, so the transcript is found). A reply in progress would be cut,
   * so a busy chat makes us wait or ask first.
   */
  private async reopenClaudeCodeChats(p: Profile, here: boolean): Promise<void> {
    if (!this.hasClaudeCodeExtension() || !cfg().get<boolean>('syncClaudeCodeExtension', true)) return;
    const mode = cfg().get<string>('reloadAfterSwitch', 'auto');
    if (mode === 'never') return;
    const chats = await claudeCodeChats(1500, process.pid, this.chatConfigDirs());
    if (chats && chats.count === 0) return; // nothing open: new chats already use the new account
    const reload = () => vscode.commands.executeCommand('workbench.action.reloadWindow');
    const n = chats?.count;
    const what = n === undefined ? 'Open Claude Code chats' : n === 1 ? 'The open Claude Code chat' : `${n} open Claude Code chats`;

    if (mode === 'ask' || chats === undefined) {
      const a = await vscode.window.showInformationMessage(
        `${what} still use the previous account. Reload the window to reopen ${n === 1 ? 'it' : 'them'} on “${p.name}”?`,
        'Reload Window',
      );
      if (a) await reload();
      return;
    }
    if (chats.busy === 0) {
      this.log.appendLine(`[switch] reloading window to reopen ${chats.count} Claude Code chat(s) on ${p.name}`);
      await reload();
      return;
    }
    if (!here) {
      void this.reloadWhenIdle(p);
      return;
    }
    const a = await vscode.window.showWarningMessage(
      'A Claude Code chat is still working.',
      {
        modal: true,
        detail: `To use “${p.name}”, open chats are reopened by reloading the window. Reloading now stops the reply in progress; the chat comes back and you can ask it to continue.`,
      },
      'Reload When Idle',
      'Reload Now',
    );
    if (a === 'Reload Now') await reload();
    else if (a === 'Reload When Idle') void this.reloadWhenIdle(p);
  }

  /** Config folders a chat process may have been started with (status files live in <dir>/sessions). */
  private chatConfigDirs(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of this.store.all()) {
      let real = p.configDir;
      try {
        real = fs.realpathSync(path.join(p.configDir, 'sessions'));
      } catch {
        /* keep the plain path */
      }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(p.configDir);
    }
    return out;
  }

  private async reloadWhenIdle(p: Profile): Promise<void> {
    if (this.waitingForIdle) return;
    this.waitingForIdle = true;
    try {
      const done = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Claude: reopening Claude Code chats on “${p.name}” once they finish…`,
          cancellable: true,
        },
        async (_progress, token) => {
          const started = Date.now();
          let quiet = 0;
          while (!token.isCancellationRequested && Date.now() - started < 30 * 60_000) {
            const chats = await claudeCodeChats(2000, process.pid, this.chatConfigDirs());
            if (!chats || chats.count === 0) return 'none';
            quiet = chats.busy === 0 ? quiet + 1 : 0;
            if (quiet >= 2) return 'idle';
            await new Promise((r) => setTimeout(r, 2000));
          }
          return token.isCancellationRequested ? 'cancelled' : 'timeout';
        },
      );
      if (done === 'idle' && this.store.active.id === p.id) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      } else if (done === 'timeout') {
        const a = await vscode.window.showInformationMessage('Claude Code is still busy. Reload the window when it is done to move open chats to the new account.', 'Reload Window');
        if (a) await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } finally {
      this.waitingForIdle = false;
    }
  }

  private async unlink(): Promise<void> {
    if (this.store.active.isDefault) {
      void vscode.window.showInformationMessage('Claude: already using the default ~/.claude account.');
      return;
    }
    await this.switchTo(this.store.defaultProfile());
  }

  private async login(p: Profile, extraArgs: string[] = [], fresh = false): Promise<void> {
    const bin = this.requireBin();
    if (!bin) return;
    const st = this.stateOf(p.id);
    if (!fresh && isLoggedIn(st)) {
      const ok = await vscode.window.showWarningMessage(
        `“${p.name}” is already logged in as ${emailOf(st) ?? 'an account'}. Log in again?`,
        { modal: true, detail: 'The new login replaces the current one for this entry.' },
        'Log In Again',
      );
      if (!ok) return;
    }
    if (!p.isDefault) fs.mkdirSync(p.configDir, { recursive: true, mode: 0o700 });
    this.loginWatches.get(p.id)?.();
    const term = createAccountTerminal(p, {
      name: `Claude login · ${p.name}`,
      command: { bin, args: ['auth', 'login', ...extraArgs] },
      icon: 'sign-in',
    });
    term.show();
    st.busy = 'login';
    this.render();
    this.watchLogin(p, term, st.auth);
  }

  /** Polls the official `claude auth status` until the login in the terminal completes. */
  private watchLogin(p: Profile, term: vscode.Terminal, before?: cli.AuthStatus): void {
    const st = this.stateOf(p.id);
    const started = Date.now();
    let checking = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      closeSub.dispose();
      this.loginWatches.delete(p.id);
      if (st.busy === 'login') st.busy = undefined;
      this.render();
    };
    const check = async (final: boolean) => {
      if (checking || stopped) return;
      const bin = this.bin();
      if (!bin) return stop();
      checking = true;
      try {
        const now = await cli.getAuthStatus(bin, p);
        const changed = now.loggedIn && (!before?.loggedIn || now.email !== before.email);
        if (changed || (final && now.loggedIn)) {
          st.auth = now;
          st.usage = undefined;
          st.usageError = undefined;
          stop();
          await this.onLoggedIn(p, term);
        } else if (final || Date.now() - started > LOGIN_TIMEOUT_MS) {
          st.auth = now;
          stop();
          await this.discardIfPending(p, final ? 'The login did not complete' : 'The login timed out');
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(term.exitStatus !== undefined), 3000);
    const closeSub = vscode.window.onDidCloseTerminal((t) => {
      if (t === term) void check(true);
    });
    this.loginWatches.set(p.id, stop);
  }

  /** A brand-new account whose first login failed is removed again, folder included. */
  private async discardIfPending(p: Profile, reason: string, quiet = false): Promise<boolean> {
    const rec = this.store.get(p.id);
    if (!rec?.pending) return false;
    if (isLoggedIn(this.stateOf(p.id))) {
      this.store.confirm(p.id);
      return false;
    }
    const wasActive = this.store.active.id === p.id;
    this.store.remove(p.id);
    this.states.delete(p.id);
    if (rec.managed && this.store.isManagedDir(rec.configDir) && isDirectory(rec.configDir)) {
      removeLinks(rec.configDir); // links first: shared data is never touched
      try {
        fs.rmSync(rec.configDir, { recursive: true, force: true });
      } catch (e) {
        this.log.appendLine(`[discard] could not delete ${rec.configDir}: ${errorText(e)}`);
      }
    }
    this.log.appendLine(`[discard] “${rec.name}”: ${reason}; removed`);
    if (wasActive) await this.applyActive();
    this.saveUsage();
    this.render();
    if (!quiet) {
      const a = await vscode.window.showWarningMessage(`${reason}, so the new account was removed.`, 'Try Again');
      if (a) await vscode.commands.executeCommand('claudeSwitch.addAccount');
    }
    return true;
  }

  private async onLoggedIn(p: Profile, term: vscode.Terminal): Promise<void> {
    this.store.confirm(p.id);
    setTimeout(() => term.dispose(), 1500);
    await this.refreshProfile(p);
    this.saveUsage();
    const st = this.stateOf(p.id);
    const email = emailOf(st);
    const name = this.store.get(p.id)?.name ?? p.name;
    const dup = email
      ? this.store.all().find((o) => o.id !== p.id && emailOf(this.stateOf(o.id))?.toLowerCase() === email.toLowerCase())
      : undefined;
    const who = name === email || !email ? `Claude: logged in as ${email ?? name}.` : `Claude: “${name}” logged in as ${email}.`;
    const msg = `${who}${dup ? ` “${dup.name}” is the same account.` : ''}`;
    const actions = this.store.active.id === p.id ? ['Check Quota'] : ['Switch Now', 'Check Quota'];
    const a = await vscode.window.showInformationMessage(msg, ...actions);
    if (a === 'Switch Now') await this.switchTo(p);
    else if (a === 'Check Quota') await this.checkQuota(p, false);
  }

  private async logout(p: Profile): Promise<void> {
    const bin = this.requireBin();
    if (!bin) return;
    const st = this.stateOf(p.id);
    const ok = await vscode.window.showWarningMessage(
      `Log out “${p.name}”${emailOf(st) ? ` (${emailOf(st)})` : ''}?`,
      { modal: true, detail: 'Runs `claude auth logout` for this account; Claude Code deletes its key. Sessions and memory are kept.' },
      'Log Out',
    );
    if (!ok) return;
    st.busy = 'logout';
    this.render();
    try {
      const r = await cli.logout(bin, p);
      if (r.code !== 0) {
        const msg = cli.stripAnsi(r.stderr || r.stdout).trim().split(/\r?\n/)[0];
        void vscode.window.showErrorMessage(`Logout failed: ${msg || `exit code ${r.code}`}`);
      }
    } finally {
      st.busy = undefined;
      st.usage = undefined;
      st.usageError = undefined;
      this.saveUsage();
      await this.refreshProfile(p);
    }
  }

  /** Queues `/usage` for one account. A manual check jumps ahead of a background scan. */
  private checkQuota(p: Profile, quiet: boolean): Promise<void> {
    const bin = quiet ? this.bin() : this.requireBin();
    if (!bin) return Promise.resolve();
    return this.quota.enqueue([p.id], { front: !quiet, quiet });
  }

  private async checkAllQuota(quiet: boolean): Promise<void> {
    const targets = this.store.all().filter((p) => isLoggedIn(this.stateOf(p.id)));
    if (!targets.length) {
      if (!quiet) void vscode.window.showInformationMessage('No logged-in Claude account to check.');
      return;
    }
    const bin = quiet ? this.bin() : this.requireBin();
    if (!bin) return;
    await this.quota.enqueue(this.activeFirst(targets).map((p) => p.id), { quiet });
  }

  /** Runs `/usage` for one account. Only the queue calls this. */
  private async runUsage(id: string, quiet: boolean): Promise<void> {
    const p = this.store.get(id);
    const bin = this.bin();
    if (!p || !bin || this.disposed) return;
    const st = this.stateOf(p.id);
    if (st.busy || !isLoggedIn(st)) return; // logged out or logging out while it waited in the queue
    st.busy = 'usage';
    st.usageError = undefined;
    this.render();
    try {
      const fetch = async () => {
        st.usage = await cli.fetchUsage(bin, p);
      };
      if (quiet) await fetch();
      else await vscode.window.withProgress({ location: { viewId: this.visibleViewId() } }, fetch);
      st.meta = cli.readAccountMeta(p);
      this.saveUsage();
    } catch (e) {
      st.usageError = errorText(e);
      this.log.appendLine(`[usage] ${p.name}: ${st.usageError}`);
    } finally {
      st.busy = undefined;
      this.render();
    }
  }

  private async showUsageDetails(p: Profile): Promise<void> {
    let st = this.stateOf(p.id);
    if (!st.usage?.raw) {
      await this.checkQuota(p, false);
      st = this.stateOf(p.id);
    }
    if (!st.usage?.raw) return;
    this.log.appendLine('');
    this.log.appendLine(`════ /usage — ${p.name}${emailOf(st) ? ` (${emailOf(st)})` : ''} — ${new Date(st.usage.fetchedAt).toLocaleString()} ════`);
    this.log.appendLine(st.usage.raw);
    this.log.show(true);
  }

  private async revealCredentials(p: Profile): Promise<void> {
    const file = cli.credentialsFile(p);
    if (fs.existsSync(file)) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
      return;
    }
    if (process.platform === 'darwin') {
      const service = cli.keychainService(p);
      const exists = await cli.keychainHasItem(service);
      const a = await vscode.window.showInformationMessage(
        `“${p.name}” key ${exists ? 'is stored' : 'would be stored'} in macOS Keychain as “${service}” (managed by Claude Code).`,
        'Open Keychain Access',
        'Copy Service Name',
      );
      if (a === 'Open Keychain Access') execFile('/usr/bin/open', ['-a', 'Keychain Access']);
      if (a === 'Copy Service Name') await vscode.env.clipboard.writeText(service);
      return;
    }
    void vscode.window.showInformationMessage(`No key stored for “${p.name}” — log in first.`);
  }

  private async unifyShared(p: Profile): Promise<void> {
    if (!this.shareEnabled()) {
      void vscode.window.showInformationMessage('Sharing is disabled (claudeSwitch.shareData).');
      return;
    }
    const report = syncLinks(p.configDir, this.shareExclude(), true);
    if (!report.conflicts.length) {
      void vscode.window.showInformationMessage(`“${p.name}” already shares sessions & memory with ~/.claude.`);
      await this.refreshProfile(p);
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Unify ${report.conflicts.length} item(s) of “${p.name}” with ~/.claude?`,
      {
        modal: true,
        detail:
          `Separate in this account: ${report.conflicts.join(', ')}.\n\n` +
          'Each item is moved to a backup folder inside the account folder, its content is copied into ~/.claude ' +
          'without overwriting anything, then it is replaced by a link. Quit running Claude sessions of this account first.',
      },
      'Unify',
    );
    if (!ok) return;
    const res = unifyWithShared(p.configDir, report.conflicts);
    this.log.appendLine(`[unify] ${p.name}: ${res.unified.join(', ') || '—'}; backup ${res.backupDir}; errors ${res.errors.join('; ') || '—'}`);
    await this.refreshProfile(p);
    if (res.errors.length) {
      void vscode.window.showWarningMessage(`Unified ${res.unified.length}; failed: ${res.errors.join('; ')}`);
    } else {
      const a = await vscode.window.showInformationMessage(
        `Unified ${res.unified.join(', ')}. Originals kept in ${tildify(res.backupDir)}.`,
        'Reveal Backup',
      );
      if (a) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.backupDir));
    }
  }

  private async remove(p: Profile): Promise<void> {
    const st = this.stateOf(p.id);
    const loggedIn = isLoggedIn(st);
    const managed = p.managed && this.store.isManagedDir(p.configDir);
    const detail = [
      loggedIn ? 'Runs `claude auth logout` so Claude Code deletes this account’s key.' : '',
      managed ? `Moves ${tildify(p.configDir)} to the trash.` : `Keeps ${tildify(p.configDir)} (not created by this extension).`,
      'Shared sessions and memory in ~/.claude are not touched.',
    ]
      .filter(Boolean)
      .join('\n');
    const primary = loggedIn ? 'Log Out & Remove' : 'Remove';
    const a = await vscode.window.showWarningMessage(
      `Remove Claude account “${p.name}”?`,
      { modal: true, detail },
      ...(loggedIn ? [primary, 'Remove Without Logout'] : [primary]),
    );
    if (!a) return;

    const bin = this.bin();
    if (a === primary && loggedIn && bin) {
      const r = await cli.logout(bin, p);
      if (r.code !== 0) this.log.appendLine(`[remove] logout of ${p.name} failed: ${r.stderr || r.stdout}`);
    }
    this.loginWatches.get(p.id)?.();
    const wasActive = this.store.active.id === p.id;
    this.store.remove(p.id);
    this.states.delete(p.id);
    if (managed && isDirectory(p.configDir)) {
      removeLinks(p.configDir); // drop links first: shared data can never be affected
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(p.configDir), { recursive: true, useTrash: true });
      } catch (e) {
        this.log.appendLine(`[remove] could not trash ${p.configDir}: ${errorText(e)}`);
        void vscode.window.showWarningMessage(`Removed “${p.name}”, but its folder could not be moved to the trash: ${p.configDir}`);
      }
    }
    if (wasActive) await this.applyActive();
    this.saveUsage();
    this.render();
  }

  private async shellIntegration(): Promise<void> {
    const root = this.store.root;
    const home = os.homedir();
    const rel = root.startsWith(home + path.sep) ? root.slice(home.length + 1) : undefined;
    const posix = rel ? `"$HOME/${rel}` : `"${root}`;
    const items = [
      {
        label: 'zsh / bash',
        description: 'add to ~/.zshrc or ~/.bashrc',
        snippet: `[ -f ${posix}/env.sh" ] && . ${posix}/env.sh"`,
      },
      {
        label: 'fish',
        description: 'add to ~/.config/fish/config.fish',
        snippet: `test -f ${posix}/env.fish"; and source ${posix}/env.fish"`,
      },
      {
        label: 'PowerShell',
        description: 'add to $PROFILE',
        snippet: `if (Test-Path '${path.join(root, 'env.ps1')}') { . '${path.join(root, 'env.ps1')}' }`,
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Shell integration',
      placeHolder: 'Make terminals outside VS Code follow the active Claude account — pick your shell to copy the line',
    });
    if (!pick) return;
    await vscode.env.clipboard.writeText(pick.snippet);
    void vscode.window.showInformationMessage(`Copied: ${pick.snippet} — paste it into your shell config (${pick.description.replace('add to ', '')}).`);
  }
}
