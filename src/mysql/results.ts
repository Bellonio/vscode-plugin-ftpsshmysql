import * as vscode from 'vscode';
import { Sessions } from '../session';
import { Store } from '../store';
import { Node } from '../tree';
import { page } from '../webview/html';
import { ResultSet, runSql } from './mysql';
import { columnDefinition, ident, isReadOnly, riskyStatements, rowSql, toCsv, toJson } from './sqlgen';

interface Target { spaceId: string; database?: string }
/** "Apri dati" state: paged SELECT on one table, with optional WHERE and ORDER BY. */
interface Browse { spaceId: string; database: string; table: string; offset: number; where: string; order?: { col: string; desc: boolean } }

/** SQL documents remember which space/database they run against. */
const docTargets = new Map<string, Target>();
let panel: vscode.WebviewPanel | undefined;
/** Last run, with full rows (the webview gets at most MAX_ROWS) for export and row actions. */
let last: { target: Target; sql: string; sets: ResultSet[]; browsing: boolean } | undefined;
let browse: Browse | undefined;
// ponytail: history kept in memory only, since queries can contain passwords and nothing is stored in clear.
const history: { target: Target; sql: string; title: string }[] = [];
const MAX_ROWS = 2000;
const PAGE = 100;
let status: vscode.StatusBarItem | undefined;

const titleOf = (store: Store, t: Target) => `${store.get(t.spaceId)?.name ?? ''}${t.database ? ' / ' + t.database : ''}`;

async function openSqlDoc(target: Target, content: string) {
	const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
	docTargets.set(doc.uri.toString(), target);
	await vscode.window.showTextDocument(doc);
}

/** Status bar item showing where Ctrl+Enter runs the active SQL editor; click to change it. */
export function queryStatusBar(store: Store): vscode.Disposable[] {
	status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.command = 'wsm.queryTarget';
	const update = () => {
		const doc = vscode.window.activeTextEditor?.document;
		if (doc?.languageId !== 'sql') return status!.hide();
		const t = docTargets.get(doc.uri.toString());
		status!.text = `$(database) ${t ? titleOf(store, t) : 'Scegli database'}`;
		status!.tooltip = 'Database su cui Ctrl+Enter esegue la query: clic per cambiarlo';
		status!.show();
	};
	update();
	return [status, vscode.window.onDidChangeActiveTextEditor(update), { dispose: () => { status = undefined; } }];
}

function refreshStatus(store: Store) {
	const doc = vscode.window.activeTextEditor?.document;
	const t = doc && docTargets.get(doc.uri.toString());
	if (status && t) status.text = `$(database) ${titleOf(store, t)}`;
}

/** Picks space and database for the active SQL editor. Connects, since it lists the databases. */
export async function chooseTarget(store: Store, sessions: Sessions): Promise<Target | undefined> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const space = await vscode.window.showQuickPick(
		store.all().filter(s => s.mysql).map(s => ({ label: s.name, description: s.mysql!.database || s.mysql!.host, id: s.id })),
		{ title: 'Su quale spazio eseguire la query?' });
	if (!space) return;
	const s = await sessions.open(space.id);
	if (!s) return;
	const [rows] = await (await s.getMysql()).query<any[]>({ sql: 'SHOW DATABASES', rowsAsArray: true });
	const dbs = rows.map(r => String(r[0]));
	const def = store.get(space.id)?.mysql?.database;
	if (def && dbs.includes(def)) dbs.unshift(...dbs.splice(dbs.indexOf(def), 1));
	const database = await vscode.window.showQuickPick(dbs, { title: `Database di ${space.label}` });
	if (!database) return;
	const target = { spaceId: space.id, database };
	docTargets.set(editor.document.uri.toString(), target);
	refreshStatus(store);
	return target;
}

export async function newQuery(node: Node) {
	if (node?.kind !== 'db' && node?.kind !== 'database') return;
	const database = node.kind === 'database' ? node.database : undefined;
	await openSqlDoc({ spaceId: node.spaceId, database }, `-- ${database ?? 'MySQL'}: Ctrl+Enter esegue la selezione (o tutto)\n`);
}

/** Structure commands: an editor pre-filled with the SQL, run by the user with Ctrl+Enter after reviewing it. */
export async function sqlTemplate(node: Node, what: 'newTable' | 'addColumn' | 'renameTable' | 'addIndex' | 'dropColumn' | 'dropIndex') {
	if (node?.kind !== 'database' && node?.kind !== 'table' && node?.kind !== 'tableInfo') return;
	const t = node.kind !== 'database' ? ident(node.table) : '';
	const name = node.kind === 'tableInfo' ? node.text : '';
	const sql = {
		newTable: 'CREATE TABLE `nuova_tabella` (\n\t`id` INT UNSIGNED NOT NULL AUTO_INCREMENT,\n\tPRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n',
		addColumn: `ALTER TABLE ${t}\n\tADD COLUMN \`nuova_colonna\` VARCHAR(255) NULL;\n`,
		renameTable: `RENAME TABLE ${t} TO \`nuovo_nome\`;\n`,
		addIndex: `ALTER TABLE ${t}\n\tADD INDEX \`idx_nome\` (\`colonna\`);\n-- unico: ADD UNIQUE INDEX \`uq_nome\` (\`colonna\`)\n`,
		dropColumn: `ALTER TABLE ${t}\n\tDROP COLUMN ${ident(name)};\n`,
		dropIndex: name === 'PRIMARY' ? `ALTER TABLE ${t}\n\tDROP PRIMARY KEY;\n` : `ALTER TABLE ${t}\n\tDROP INDEX ${ident(name)};\n`,
	}[what];
	await openSqlDoc({ spaceId: node.spaceId, database: node.database }, `-- ${node.database}: controlla e premi Ctrl+Enter per eseguire\n${sql}`);
}

/** CHANGE COLUMN with the current definition, so type, NULL, default and name can all be edited in place. */
export async function editColumn(sessions: Sessions, node: Node) {
	if (node?.kind !== 'tableInfo' || node.contextValue !== 'column') return;
	const s = await sessions.open(node.spaceId);
	if (!s) return;
	const [rows] = await (await s.getMysql()).query<any[]>({ sql: `SHOW CREATE TABLE ${ident(node.database)}.${ident(node.table)}`, rowsAsArray: true });
	const def = columnDefinition(String(rows[0][1]), node.text) ?? node.description;
	await openSqlDoc({ spaceId: node.spaceId, database: node.database },
		`-- ${node.database}: modifica tipo/default/nome e premi Ctrl+Enter per eseguire\nALTER TABLE ${ident(node.table)}\n\tCHANGE COLUMN ${ident(node.text)} ${ident(node.text)} ${def};\n`);
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

/** Asks before running DROP/TRUNCATE/DELETE or UPDATE without WHERE. */
async function confirmRisky(sql: string): Promise<boolean> {
	const risky = riskyStatements(sql);
	if (!risky.length) return true;
	const list = risky.slice(0, 5).map(r => r.length > 100 ? r.slice(0, 100) + '…' : r).join('\n');
	const ok = await vscode.window.showWarningMessage('La query contiene istruzioni distruttive:', { modal: true, detail: `${list}${risky.length > 5 ? `\n... e altre ${risky.length - 5}` : ''}` }, 'Esegui comunque');
	return ok === 'Esegui comunque';
}

export async function runQuery(store: Store, sessions: Sessions) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const target = docTargets.get(editor.document.uri.toString()) ?? await chooseTarget(store, sessions);
	if (!target) return;
	const sql = (editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection)).trim();
	if (sql && await confirmRisky(sql)) await execute(store, sessions, target, sql);
}

export async function openTable(store: Store, sessions: Sessions, node: Node) {
	if (node?.kind !== 'table') return;
	browse = { spaceId: node.spaceId, database: node.database, table: node.table, offset: 0, where: '' };
	await runBrowse(store, sessions);
}

async function runBrowse(store: Store, sessions: Sessions) {
	const b = browse!;
	const sql = `SELECT * FROM ${ident(b.database)}.${ident(b.table)}${b.where.trim() ? `\nWHERE ${b.where.trim()}` : ''}`
		+ `${b.order ? `\nORDER BY ${ident(b.order.col)} ${b.order.desc ? 'DESC' : 'ASC'}` : ''}\nLIMIT ${PAGE} OFFSET ${b.offset}`;
	// The WHERE is typed by the user and the connection allows multiple statements: same check as the editor.
	return await confirmRisky(sql) && execute(store, sessions, { spaceId: b.spaceId, database: b.database }, sql, true);
}

async function execute(store: Store, sessions: Sessions, target: Target, sql: string, browsing = false): Promise<boolean> {
	const s = await sessions.open(target.spaceId);
	if (!s) return false;
	const view = show(store, sessions);
	const title = titleOf(store, target);
	if (!browsing && history[0]?.sql !== sql) {
		history.unshift({ target, sql, title });
		history.length = Math.min(history.length, 50);
	}
	const common = {
		title, sql,
		canRerun: isReadOnly(sql),
		browse: browsing && browse ? { table: browse.table, where: browse.where, offset: browse.offset, order: browse.order, page: PAGE } : undefined,
		back: !browsing && browse ? browse.table : undefined,
		history: history.map(h => `${h.title}: ${h.sql.replace(/\s+/g, ' ').slice(0, 80)}`),
	};
	view.webview.postMessage({ ...common, type: 'running' });
	last = { target, sql, sets: [], browsing };
	const t0 = Date.now();
	try {
		const sets: ResultSet[] = await runSql(await s.getMysql(), sql, target.database);
		last.sets = sets;
		// ponytail: plain HTML table, so huge result sets are cut; add virtual scrolling if this becomes a limit.
		const shown = sets.map(r => ({ ...r, total: r.rows.length, rows: r.rows.slice(0, MAX_ROWS), editable: !!r.source }));
		view.webview.postMessage({ ...common, type: 'result', ms: Date.now() - t0, sets: shown });
		return true;
	} catch (e: any) {
		view.webview.postMessage({ ...common, type: 'error', ms: Date.now() - t0, message: e?.sqlMessage ?? e?.message ?? String(e), code: e?.code });
		return false;
	}
}

async function exportSet(index: number, format: 'csv' | 'json') {
	const set = last?.sets[index];
	if (!set) return;
	const uri = await vscode.window.showSaveDialog({ title: 'Esporta risultati', filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] } });
	if (!uri) return;
	const text = format === 'csv' ? toCsv(set.columns, set.rows) : toJson(set.columns, set.rows);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
	vscode.window.showInformationMessage(`Esportate ${set.rows.length} righe in ${uri.fsPath}`);
}

/** Opens an editor with the UPDATE/INSERT/DELETE for one result row, identified by primary key when possible. */
async function rowAction(sessions: Sessions, setIndex: number, rowIndex: number, action: 'update' | 'insert' | 'delete') {
	const set = last?.sets[setIndex], row = set?.rows[rowIndex];
	if (!last || !set?.source || !row) return;
	const s = await sessions.open(last.target.spaceId);
	if (!s) return;
	const [keys] = await (await s.getMysql()).query<any[]>(
		`SHOW KEYS FROM ${ident(set.source.table)} FROM ${ident(set.source.db)} WHERE Key_name = 'PRIMARY'`);
	const pk = keys.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(k => String(k.Column_name));
	const label = { update: 'modifica i valori', insert: 'modifica i valori della copia', delete: 'controlla la riga da eliminare' }[action];
	await openSqlDoc({ spaceId: last.target.spaceId, database: set.source.db },
		`-- ${set.source.db}.${set.source.table}: ${label} e premi Ctrl+Enter per eseguire\n${rowSql(action, set.source, row, pk)}`);
}

async function onMessage(store: Store, sessions: Sessions, m: any) {
	switch (m?.type) {
		case 'export': return exportSet(m.index, m.format);
		case 'copy': await vscode.env.clipboard.writeText(String(m.text)); return vscode.window.setStatusBarMessage('Copiato negli appunti', 2000);
		case 'rerun': return last && isReadOnly(last.sql) && (last.browsing ? runBrowse(store, sessions) : execute(store, sessions, last.target, last.sql));
		case 'edit': return last && openSqlDoc(last.target, last.sql + '\n');
		case 'history': { const h = history[m.index]; return h && openSqlDoc(h.target, h.sql + '\n'); }
		case 'row': return rowAction(sessions, m.set, m.row, m.action);
		case 'browse': {
			if (!browse) return;
			if (typeof m.where === 'string') browse = { ...browse, where: m.where, offset: 0 };
			if (m.order) browse = { ...browse, offset: 0, order: { col: m.order, desc: browse.order?.col === m.order && !browse.order?.desc } };
			if (m.delta) browse = { ...browse, offset: Math.max(0, browse.offset + m.delta * PAGE) };
			return runBrowse(store, sessions);
		}
	}
}

function show(store: Store, sessions: Sessions): vscode.WebviewPanel {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Beside, true);
		return panel;
	}
	panel = vscode.window.createWebviewPanel('wsm.results', 'Risultati SQL', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{ enableScripts: true, retainContextWhenHidden: true });
	panel.onDidDispose(() => { panel = undefined; last = undefined; browse = undefined; });
	panel.webview.onDidReceiveMessage(m => onMessage(store, sessions, m)
		.catch(e => vscode.window.showErrorMessage(e?.message ?? String(e))));
	panel.webview.html = page(panel.webview, 'Risultati SQL', `
body { padding: 8px 12px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; }
.grow { flex: 1; }
button.small { padding: 2px 8px; }
button:disabled { opacity: .5; cursor: default; }
select { max-width: 320px; }
pre.sql { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; max-height: 120px; overflow: auto; white-space: pre-wrap; margin: 0 0 8px; }
.wrap { overflow: auto; max-height: calc(100vh - 230px); margin-bottom: 16px; }
table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); cursor: pointer; user-select: none; }
th.acts { cursor: default; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
td.acts { padding: 0 2px; }
td.acts button { background: none; color: var(--vscode-foreground); padding: 1px 5px; opacity: .45; }
tr:hover td.acts button { opacity: 1; }
td.acts button:hover { background: var(--vscode-toolbar-hoverBackground); }
input.where { flex: 1; min-width: 200px; font-family: var(--vscode-editor-font-family); }`,
	`<div class="bar"><strong id="title"></strong> <span id="meta" class="muted"></span><span class="grow"></span>
<button class="secondary small" id="rerun" title="Esegui di nuovo (solo query di lettura)">&#8635; Riesegui</button>
<button class="secondary small" id="edit" title="Apri questa query in un editor SQL">&#9998; Apri nell'editor</button>
<button class="secondary small" id="back"></button>
<select id="hist" title="Query eseguite in questa sessione: sceglila per riaprirla nell'editor"></select></div>
<div class="bar" id="browse"></div>
<pre class="sql" id="sql"></pre><div id="out"></div>`,
	`
const $ = id => document.getElementById(id);
let cur, views = [];
const fmt = v => v === null || v === undefined ? null : typeof v === 'object' ? (v.type === 'Buffer' ? '[binario ' + (v.data?.length ?? 0) + ' byte]' : JSON.stringify(v)) : String(v);
const cell = v => { const s = fmt(v); return s === null ? '<td class="null">NULL</td>' : '<td title="' + esc(s) + '">' + esc(s) + '</td>'; };
function cmp(a, b) {
	if (a === b) return 0;
	if (a === null || a === undefined) return -1;
	if (b === null || b === undefined) return 1;
	const na = Number(a), nb = Number(b);
	return a !== '' && b !== '' && !isNaN(na) && !isNaN(nb) ? na - nb : fmt(a).localeCompare(fmt(b));
}
/** Row indexes after the client-side filter and sort (in table browsing the sort is done by the server). */
function visible(i) {
	const s = cur.sets[i], v = views[i];
	let idx = s.rows.map((_, r) => r);
	if (v.filter) { const f = v.filter.toLowerCase(); idx = idx.filter(r => s.rows[r].some(x => (fmt(x) ?? 'null').toLowerCase().includes(f))); }
	if (v.sort) idx.sort((a, b) => cmp(s.rows[a][v.sort.c], s.rows[b][v.sort.c]) * v.sort.d);
	return idx;
}
const ACTS = '<td class="acts"><button data-a="update" title="Modifica riga (apre l\\'UPDATE)">&#9998;</button><button data-a="insert" title="Duplica riga (apre l\\'INSERT)">&#10697;</button><button data-a="delete" title="Elimina riga (apre il DELETE)">&#10005;</button></td>';
function arrow(i, c) {
	const name = cur.sets[i].columns[c];
	if (cur.browse) return cur.browse.order?.col === name ? (cur.browse.order.desc ? ' &#9660;' : ' &#9650;') : '';
	const s = views[i].sort;
	return s?.c === c ? (s.d < 0 ? ' &#9660;' : ' &#9650;') : '';
}
function renderSet(i) {
	const s = cur.sets[i], rows = visible(i), el = document.querySelector('.set[data-i="' + i + '"]');
	el.querySelector('.count').textContent = (views[i].filter ? rows.length + ' di ' : '') + s.total + ' righe' + (s.total > s.rows.length ? ' (mostrate le prime ' + s.rows.length + ')' : '');
	el.querySelector('thead').innerHTML = '<tr>' + (s.editable ? '<th class="acts"></th>' : '') + s.columns.map((c, ci) => '<th data-c="' + ci + '" title="Ordina">' + esc(c) + arrow(i, ci) + '</th>').join('') + '</tr>';
	el.querySelector('tbody').innerHTML = rows.map(r => '<tr data-r="' + r + '">' + (s.editable ? ACTS : '') + s.rows[r].map(cell).join('') + '</tr>').join('');
}
function renderBrowse(m) {
	const b = m.browse, el = $('browse');
	el.style.display = b ? '' : 'none';
	if (!b) return;
	const n = m.sets?.[0]?.rows.length ?? 0;
	el.innerHTML = '<strong>' + esc(b.table) + '</strong><span class="muted">WHERE</span><input class="where" id="where" placeholder="es. id > 10 AND stato = \\'attivo\\' (Invio per applicare)" value="' + esc(b.where) + '">' +
		'<button class="secondary small" id="prev"' + (b.offset > 0 ? '' : ' disabled') + '>&#9664;</button>' +
		'<span class="muted">' + (n ? (b.offset + 1) + '–' + (b.offset + n) : 'nessuna riga') + '</span>' +
		'<button class="secondary small" id="next"' + (n >= b.page ? '' : ' disabled') + '>&#9654;</button>';
}
window.addEventListener('message', ({ data: m }) => {
	cur = m;
	$('title').textContent = m.title; $('sql').textContent = m.sql;
	$('rerun').disabled = !m.canRerun;
	$('back').style.display = m.back ? '' : 'none';
	$('back').innerHTML = '&#8617; Torna a ' + esc(m.back ?? '');
	$('hist').innerHTML = '<option value="">Cronologia (' + m.history.length + ')</option>' + m.history.map((h, i) => '<option value="' + i + '">' + esc(h) + '</option>').join('');
	renderBrowse(m);
	if (m.type === 'running') { $('meta').textContent = 'esecuzione...'; $('out').innerHTML = ''; return; }
	$('meta').textContent = m.ms + ' ms';
	if (m.type === 'error') { $('out').innerHTML = '<p class="error">' + esc((m.code ? m.code + ': ' : '') + m.message) + '</p>'; return; }
	views = m.sets.map(() => ({ filter: '', sort: null }));
	$('out').innerHTML = m.sets.map((s, i) => s.info !== undefined ? '<p>' + esc(s.info) + '</p>' :
		'<div class="set" data-i="' + i + '"><div class="bar"><span class="muted count"></span>' +
		'<input class="filter" placeholder="Filtra righe mostrate..." style="width: 220px">' +
		(s.editable ? '<span class="muted">&#9998; modifica, &#10697; duplica, &#10005; elimina: aprono l\\'SQL da confermare</span>' : '') +
		'<span class="grow"></span><span class="muted">doppio clic su una cella la copia</span>' +
		'<button class="secondary small" data-x="copy" title="Copia le righe mostrate (incollabili in Excel)">Copia</button>' +
		'<button class="secondary small" data-x="csv">CSV</button><button class="secondary small" data-x="json">JSON</button></div>' +
		'<div class="wrap"><table><thead></thead><tbody></tbody></table></div></div>').join('');
	m.sets.forEach((s, i) => s.info === undefined && renderSet(i));
});
const setOf = e => { const el = e.target.closest('.set'); return el ? Number(el.dataset.i) : -1; };
document.addEventListener('click', e => {
	const t = e.target, i = setOf(e);
	if (t.id === 'rerun') return vscode.postMessage({ type: 'rerun' });
	if (t.id === 'edit') return vscode.postMessage({ type: 'edit' });
	if (t.id === 'back') return vscode.postMessage({ type: 'browse' });
	if (t.id === 'prev' || t.id === 'next') return vscode.postMessage({ type: 'browse', delta: t.id === 'next' ? 1 : -1 });
	const act = t.closest('td.acts button');
	if (act) return vscode.postMessage({ type: 'row', set: i, row: Number(act.closest('tr').dataset.r), action: act.dataset.a });
	const th = t.closest('th[data-c]');
	if (th) {
		const c = Number(th.dataset.c);
		if (cur.browse) return vscode.postMessage({ type: 'browse', order: cur.sets[i].columns[c] });
		const s = views[i].sort;
		views[i].sort = s?.c === c ? (s.d > 0 ? { c, d: -1 } : null) : { c, d: 1 };
		return renderSet(i);
	}
	const x = t.dataset?.x;
	if (x === 'csv' || x === 'json') return vscode.postMessage({ type: 'export', index: i, format: x });
	if (x === 'copy') {
		const s = cur.sets[i];
		const tsv = [s.columns, ...visible(i).map(r => s.rows[r].map(v => fmt(v) ?? 'NULL'))].map(r => r.map(v => String(v).replace(/[\\t\\r\\n]+/g, ' ')).join('\\t')).join('\\n');
		vscode.postMessage({ type: 'copy', text: tsv });
	}
});
document.addEventListener('dblclick', e => {
	const td = e.target.closest('td:not(.acts)');
	if (!td) return;
	const s = cur.sets[setOf(e)], tr = td.closest('tr');
	const c = [...tr.children].indexOf(td) - (s.editable ? 1 : 0);
	vscode.postMessage({ type: 'copy', text: fmt(s.rows[Number(tr.dataset.r)][c]) ?? 'NULL' });
});
document.addEventListener('input', e => {
	if (!e.target.classList.contains('filter')) return;
	const i = setOf(e);
	views[i].filter = e.target.value;
	renderSet(i);
});
document.addEventListener('keydown', e => {
	if (e.target.id === 'where' && e.key === 'Enter') vscode.postMessage({ type: 'browse', where: e.target.value });
});
$('hist').addEventListener('change', e => {
	if (e.target.value !== '') vscode.postMessage({ type: 'history', index: Number(e.target.value) });
	e.target.value = '';
});`);
	return panel;
}
