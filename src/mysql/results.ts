import * as vscode from 'vscode';
import { Sessions } from '../session';
import { Store } from '../store';
import { Node } from '../tree';
import { page } from '../webview/html';
import { ResultSet, runSql } from './mysql';

interface Target { spaceId: string; database?: string }

/** Untitled SQL documents opened from the tree remember which space/database they run against. */
const docTargets = new Map<string, Target>();
let panel: vscode.WebviewPanel | undefined;
const MAX_ROWS = 2000;

export async function newQuery(node: Node) {
	if (node?.kind !== 'db' && node?.kind !== 'database') return;
	const database = node.kind === 'database' ? node.database : undefined;
	const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- ${database ?? 'MySQL'}: Ctrl+Enter esegue la selezione (o tutto)\n` });
	docTargets.set(doc.uri.toString(), { spaceId: node.spaceId, database });
	await vscode.window.showTextDocument(doc);
}

export async function runQuery(store: Store, sessions: Sessions) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	let target = docTargets.get(editor.document.uri.toString());
	if (!target) {
		const pick = await vscode.window.showQuickPick(
			store.all().filter(s => s.mysql).map(s => ({ label: s.name, description: s.mysql!.database, target: { spaceId: s.id, database: s.mysql!.database } })),
			{ title: 'Su quale database eseguire la query?' });
		if (!pick) return;
		target = pick.target;
		docTargets.set(editor.document.uri.toString(), target);
	}
	const sql = (editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection)).trim();
	if (sql) await execute(store, sessions, target, sql);
}

export async function openTable(store: Store, sessions: Sessions, node: Node) {
	if (node?.kind !== 'table') return;
	const s = await sessions.open(node.spaceId);
	if (!s) return;
	const conn = await s.getMysql();
	await execute(store, sessions, { spaceId: node.spaceId, database: node.database }, `SELECT * FROM ${conn.escapeId(node.table)} LIMIT 100`);
}

async function execute(store: Store, sessions: Sessions, target: Target, sql: string) {
	const s = await sessions.open(target.spaceId);
	if (!s) return;
	const view = show();
	const title = `${store.get(target.spaceId)?.name ?? ''}${target.database ? ' / ' + target.database : ''}`;
	view.webview.postMessage({ type: 'running', title, sql });
	const t0 = Date.now();
	try {
		const sets: ResultSet[] = await runSql(await s.getMysql(), sql, target.database);
		// ponytail: plain HTML table, so huge result sets are cut; add virtual scrolling if this becomes a limit.
		const shown = sets.map(r => ({ ...r, total: r.rows.length, rows: r.rows.slice(0, MAX_ROWS) }));
		view.webview.postMessage({ type: 'result', title, sql, ms: Date.now() - t0, sets: shown });
	} catch (e: any) {
		view.webview.postMessage({ type: 'error', title, sql, ms: Date.now() - t0, message: e?.sqlMessage ?? e?.message ?? String(e), code: e?.code });
	}
}

function show(): vscode.WebviewPanel {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Beside, true);
		return panel;
	}
	panel = vscode.window.createWebviewPanel('wsm.results', 'Risultati SQL', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{ enableScripts: true, retainContextWhenHidden: true });
	panel.onDidDispose(() => (panel = undefined));
	panel.webview.html = page(panel.webview, 'Risultati SQL', `
body { padding: 8px 12px; }
.head { margin-bottom: 8px; }
pre.sql { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; max-height: 120px; overflow: auto; white-space: pre-wrap; }
.wrap { overflow: auto; max-height: calc(100vh - 180px); margin-bottom: 16px; }
table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); }
td.null { color: var(--vscode-descriptionForeground); font-style: italic; }`,
	`<div class="head"><strong id="title"></strong> <span id="meta" class="muted"></span></div><pre class="sql" id="sql"></pre><div id="out"></div>`,
	`
const $ = id => document.getElementById(id);
function cell(v) {
	if (v === null || v === undefined) return '<td class="null">NULL</td>';
	if (typeof v === 'object') v = v.type === 'Buffer' ? '[binario ' + (v.data?.length ?? 0) + ' byte]' : JSON.stringify(v);
	return '<td title="' + esc(v) + '">' + esc(v) + '</td>';
}
window.addEventListener('message', ({ data: m }) => {
	$('title').textContent = m.title; $('sql').textContent = m.sql;
	if (m.type === 'running') { $('meta').textContent = 'esecuzione...'; $('out').innerHTML = ''; return; }
	$('meta').textContent = m.ms + ' ms';
	if (m.type === 'error') { $('out').innerHTML = '<p class="error">' + esc((m.code ? m.code + ': ' : '') + m.message) + '</p>'; return; }
	$('out').innerHTML = m.sets.map(s => s.info !== undefined
		? '<p>' + esc(s.info) + '</p>'
		: '<p class="muted">' + s.total + ' righe' + (s.total > s.rows.length ? ' (mostrate le prime ' + s.rows.length + ')' : '') + '</p><div class="wrap"><table><thead><tr>' + s.columns.map(c => '<th>' + esc(c) + '</th>').join('') +
		  '</tr></thead><tbody>' + s.rows.map(r => '<tr>' + r.map(cell).join('') + '</tr>').join('') + '</tbody></table></div>').join('');
});`);
	return panel;
}
