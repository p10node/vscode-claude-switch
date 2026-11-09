import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { CARD_COMMANDS, CardProfile, CardsState, FromWebview, ToWebview } from './model';
import { emailOf, isLoggedIn, keyLocation, planOf, TreeHost } from './tree';
import { tildify } from './util';

export const CARDS_VIEW_ID = 'claudeSwitch.cards';

export function buildCardsState(host: TreeHost): CardsState {
  const activeId = host.store.active.id;
  const all = host.store.all();
  const share = host.shareEnabled();
  return {
    cli: host.cliHealth(),
    profiles: all.map((p): CardProfile => {
      const st = host.stateOf(p.id);
      const key = keyLocation(p, st);
      let sharing: CardProfile['sharing'] = { state: 'none', linked: 0, separate: [] };
      if (p.isDefault) {
        if (share && all.length > 1) sharing = { state: 'source', linked: 0, separate: [] };
      } else if (!share) {
        sharing = { state: 'disabled', linked: 0, separate: [] };
      } else if (st.links) {
        const separate = [...st.links.conflicts, ...st.links.errors.map((e) => e.split(':')[0])];
        sharing = { state: separate.length ? 'separate' : 'shared', linked: st.links.linked.length, separate };
      }
      return {
        id: p.id,
        name: p.name,
        isDefault: p.isDefault,
        active: p.id === activeId,
        loggedIn: isLoggedIn(st),
        email: emailOf(st),
        plan: planOf(st),
        org: st.auth?.orgName ?? st.meta?.orgName,
        busy: st.busy,
        folderMissing: !!st.folderMissing,
        usage: st.usage
          ? { limits: st.usage.limits, fetchedAt: st.usage.fetchedAt, source: st.usage.source, hasRaw: !!st.usage.raw }
          : undefined,
        usageError: st.usageError,
        authError: st.auth?.error,
        configDir: p.configDir,
        configDirShort: tildify(p.configDir),
        key: { label: key.label, detail: key.detail, present: key.present },
        sharing,
      };
    }),
  };
}

/** Sidebar webview showing one card per account. All actions go through the regular commands. */
export class CardsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: TreeHost,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.update());
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  update(): void {
    if (!this.view?.visible) return;
    const msg: ToWebview = { type: 'state', state: buildCardsState(this.host) };
    void this.view.webview.postMessage(msg);
  }

  private onMessage(m: FromWebview): void {
    if (m?.type === 'ready') {
      this.update();
    } else if (m?.type === 'run' && (CARD_COMMANDS as readonly string[]).includes(m.command)) {
      const arg = typeof m.profileId === 'string' ? { kind: 'detail', profileId: m.profileId } : undefined;
      void vscode.commands.executeCommand(`claudeSwitch.${m.command}`, arg);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('media', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('media', 'cards.css')}">
<title>Claude Accounts</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('out', 'cards.js')}"></script>
</body>
</html>`;
  }
}
