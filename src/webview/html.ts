import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** Shared page shell: strict CSP (nonce-only scripts), VSCode theme variables. */
export function page(webview: vscode.Webview, title: string, css: string, body: string, script: string): string {
	const nonce = randomBytes(16).toString('base64');
	return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 20px; }
input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font: inherit; box-sizing: border-box; }
input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; cursor: pointer; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.muted { color: var(--vscode-descriptionForeground); }
.error { color: var(--vscode-errorForeground); }
${css}
</style></head><body>${body}<script nonce="${nonce}">const vscode = acquireVsCodeApi();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
${script}</script></body></html>`;
}
