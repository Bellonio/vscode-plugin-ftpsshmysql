import * as vscode from 'vscode';
import { Sessions } from '../session';
import { Store } from '../store';
import { Node } from '../tree';
import { page } from '../webview/html';
import { ResultSet, runSql } from './mysql';
import { ident, riskyStatements, toCsv, toJson } from './sqlgen';

interface Target { spaceId: string; database?: string }

/** Untitled SQL documents opened from the tree remember which space/database they run against. */
const docTargets = new Map<string, Target>();
let panel: vscode.WebviewPanel | undefined;
/** Full rows of the last results (the webview gets at most MAX_ROWS), for the export. */
let lastSets: ResultSet[] = [];
const MAX_ROWS = 2000;

async function openSqlDoc(target: Target, content: string) {
	const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
	docTargets.set(doc.uri.toString(), target);
	await vscode.window.showTextDocument(doc);
}

export async function newQuery(node: Node) {
	if (node?.kind !== 'db' && node?.kind !== 'database') return;
	const database = node.kind === 'database' ? node.database : undefined;
	await openSqlDoc({ spaceId: node.spaceId, database }, `-- ${database ?? 'MySQL'}: Ctrl+Enter esegue la selezione (o tutto)\n`);
}

/** Structure commands: an editor pre-filled with the SQL, run by the user with Ctrl+Enter after reviewing it. */
export async function sqlTemplate(node: Node, what: 'newTable' | 'addColumn' | 'renameTable') {
	if (node?.kind !== 'database' && node?.kind !== 'table') return;
	const t = node.kind === 'table' ? ident(node.table) : '';
	const sql = {
		newTable: 'CREATE TABLE `nuova_tabella` (\n\t`id` INT UNSIGNED NOT NULL AUTO_INCREMENT,\n\tPRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n',
		addColumn: `ALTER TABLE ${t}\n\tADD COLUMN \`nuova_colonna\` VARCHAR(255) NULL;\n`,
		renameTable: `RENAME TABLE ${t} TO \`nuovo_nome\`;\n`,
	}[what];
	await openSqlDoc({ spaceId: node.spaceId, database: node.database }, `-- ${node.database}: controlla e premi Ctrl+Enter per eseguire\n${sql}`);
}

export async function showCreateTable(sessions: Sessions, node: Node) {
	if (node?.kind !== 'table') return;
	const s = await sessions.open(node.spaceId);
	if (!s) return;
	const [rows] = await (await s.getMysql()).query<any[]>({ sql: `SHOW CREATE TABLE ${ident(node.database)}.${ident(node.table)}`, rowsAsArray: true });
	await openSqlDoc({ spaceId: node.spaceId, database: node.database }, `${rows[0][1]};\n`);
}

/** Destructive commands: the user must type the name to confirm (CREATE DATABASE asks the name instead). True when the statement ran. */
export async function dangerous(store: Store, sessions: Sessions, node: Node, what: 'truncateTable' | 'dropTable' | 'dropDatabase' | 'createDatabase'): Promise<boolean> {
	if (what === 'createDatabase') {
		if (node?.kind !== 'db') return false;
		const name = (await vscode.window.showInputBox({ title: 'Nuovo database', prompt: 'Nome del database', validateInput: v => v.trim() ? undefined : 'Nome obbligatorio' }))?.trim();
		return !!name && execute(store, sessions, { spaceId: node.spaceId }, `CREATE DATABASE ${ident(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
	}
	const target = what === 'dropDatabase'
		? node?.kind === 'database' && { name: node.database, sql: `DROP DATABASE ${ident(node.database)}` }
		: node?.kind === 'table' && { name: node.table, sql: `${what === 'truncateTable' ? 'TRUNCATE TABLE' : 'DROP TABLE'} ${ident(node.database)}.${ident(node.table)}` };
	if (!target) return false;
	const label = { truncateTable: 'Svuota la tabella', dropTable: 'Elimina la tabella', dropDatabase: 'Elimina il database' }[what];
	const typed = await vscode.window.showInputBox({
		title: `${label} "${target.name}" (${store.get(node.spaceId)?.name}): operazione irreversibile`,
		prompt: `Scrivi "${target.name}" per confermare`,
		validateInput: v => v === target.name ? undefined : 'Il nome non corrisponde',
	});
	return typed === target.name && execute(store, sessions, { spaceId: node.spaceId }, target.sql);
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
	if (!sql) return;
	const risky = riskyStatements(sql);
	if (risky.length) {
		const list = risky.slice(0, 5).map(r => r.length > 100 ? r.slice(0, 100) + '…' : r).join('\n');
		const ok = await vscode.window.showWarningMessage('La query contiene istruzioni distruttive:', { modal: true, detail: `${list}${risky.length > 5 ? `\n... e altre ${risky.length - 5}` : ''}` }, 'Esegui comunque');
		if (ok !== 'Esegui comunque') return;
	}
	await execute(store, sessions, target, sql);
}

export async function openTable(store: Store, sessions: Sessions, node: Node) {
	if (node?.kind !== 'table') return;
	const s = await sessions.open(node.spaceId);
	if (!s) return;
	const conn = await s.getMysql();
	await execute(store, sessions, { spaceId: node.spaceId, database: node.database }, `SELECT * FROM ${conn.escapeId(node.table)} LIMIT 100`);
}

async function execute(store: Store, sessions: Sessions, target: Target, sql: string): Promise<boolean> {
	const s = await sessions.open(target.spaceId);
	if (!s) return false;
	const view = show();
	const title = `${store.get(target.spaceId)?.name ?? ''}${target.database ? ' / ' + target.database : ''}`;
	view.webview.postMessage({ type: 'running', title, sql });
	const t0 = Date.now();
	try {
		const sets: ResultSet[] = await runSql(await s.getMysql(), sql, target.database);
		lastSets = sets;
		// ponytail: plain HTML table, so huge result sets are cut; add virtual scrolling if this becomes a limit.
		const shown = sets.map(r => ({ ...r, total: r.rows.length, rows: r.rows.slice(0, MAX_ROWS) }));
		view.webview.postMessage({ type: 'result', title, sql, ms: Date.now() - t0, sets: shown });
		return true;
	} catch (e: any) {
		view.webview.postMessage({ type: 'error', title, sql, ms: Date.now() - t0, message: e?.sqlMessage ?? e?.message ?? String(e), code: e?.code });
		return false;
	}
}

async function exportSet(index: number, format: 'csv' | 'json') {
	const set = lastSets[index];
	if (!set) return;
	const uri = await vscode.window.showSaveDialog({ title: 'Esporta risultati', filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] } });
	if (!uri) return;
	const text = format === 'csv' ? toCsv(set.columns, set.rows) : toJson(set.columns, set.rows);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
	vscode.window.showInformationMessage(`Esportate ${set.rows.length} righe in ${uri.fsPath}`);
}

function show(): vscode.WebviewPanel {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Beside, true);
		return panel;
	}
	panel = vscode.window.createWebviewPanel('wsm.results', 'Risultati SQL', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{ enableScripts: true, retainContextWhenHidden: true });
	panel.onDidDispose(() => { panel = undefined; lastSets = []; });
	panel.webview.onDidReceiveMessage(m => m?.type === 'export' && exportSet(m.index, m.format)
		.catch(e => vscode.window.showErrorMessage(e?.message ?? String(e))));
	panel.webview.html = page(panel.webview, 'Risultati SQL', `
body { padding: 8px 12px; }
.head { margin-bottom: 8px; }
pre.sql { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; max-height: 120px; overflow: auto; white-space: pre-wrap; }
.wrap { overflow: auto; max-height: calc(100vh - 180px); margin-bottom: 16px; }
table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); }
td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
button.small { padding: 1px 8px; margin-left: 6px; }`,
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
	$('out').innerHTML = m.sets.map((s, i) => s.info !== undefined
		? '<p>' + esc(s.info) + '</p>'
		: '<p class="muted">' + s.total + ' righe' + (s.total > s.rows.length ? ' (mostrate le prime ' + s.rows.length + ')' : '') +
		  '<button class="secondary small" data-i="' + i + '" data-f="csv">CSV</button><button class="secondary small" data-i="' + i + '" data-f="json">JSON</button></p><div class="wrap"><table><thead><tr>' + s.columns.map(c => '<th>' + esc(c) + '</th>').join('') +
		  '</tr></thead><tbody>' + s.rows.map(r => '<tr>' + r.map(cell).join('') + '</tr>').join('') + '</tbody></table></div>').join('');
});
document.addEventListener('click', e => {
	const b = e.target.closest('button[data-f]');
	if (b) vscode.postMessage({ type: 'export', index: Number(b.dataset.i), format: b.dataset.f });
});`);
	return panel;
}
