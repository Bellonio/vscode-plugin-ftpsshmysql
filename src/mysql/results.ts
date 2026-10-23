import * as vscode from 'vscode';
import { Sessions } from '../session';
import { Store } from '../store';
import { Node } from '../tree';
import { page } from '../webview/html';
import type { Connection } from 'mysql2/promise';
import { ResultSet, runSql } from './mysql';
import { columnDefinition, GridChanges, gridSql, ident, isReadOnly, riskyStatements, RowSource, rowSql, toCsv, toJson } from './sqlgen';

interface Target { spaceId: string; database?: string }
/** "Apri dati" state: paged SELECT on one table, with optional WHERE and ORDER BY. */
interface Browse { spaceId: string; database: string; table: string; offset: number; where: string; order?: { col: string; desc: boolean } }

/** SQL documents remember which space/database they run against. */
const docTargets = new Map<string, Target>();
let panel: vscode.WebviewPanel | undefined;
/** Last run, with full rows (the webview gets at most MAX_ROWS) for export, row actions and grid edits. keys: primary key per set. */
let last: { id: number; target: Target; sql: string; sets: ResultSet[]; keys: string[][]; browsing: boolean } | undefined;
let runs = 0;
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
	const run = last = { id: ++runs, target, sql, sets: [] as ResultSet[], keys: [] as string[][], browsing };
	const t0 = Date.now();
	try {
		const conn = await s.getMysql();
		const sets: ResultSet[] = await runSql(conn, sql, target.database);
		const ms = Date.now() - t0;
		run.sets = sets;
		run.keys = await Promise.all(sets.map(r => r.source ? primaryKey(conn, r.source).catch(() => []) : []));
		// ponytail: plain HTML table, so huge result sets are cut; add virtual scrolling if this becomes a limit.
		const shown = sets.map((r, i) => ({
			...r, total: r.rows.length, rows: r.rows.slice(0, MAX_ROWS), editable: !!r.source, pk: run.keys[i],
			// The grid edits cells only when every primary key column is in the result, so each row is identified exactly.
			grid: run.keys[i].length > 0 && run.keys[i].every(k => r.source!.columns.includes(k)),
		}));
		view.webview.postMessage({ ...common, type: 'result', id: run.id, ms, sets: shown });
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

async function primaryKey(conn: Connection, src: RowSource): Promise<string[]> {
	const [keys] = await conn.query<any[]>(`SHOW KEYS FROM ${ident(src.table)} FROM ${ident(src.db)} WHERE Key_name = 'PRIMARY'`);
	return keys.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(k => String(k.Column_name));
}

/** Opens an editor with the UPDATE/INSERT/DELETE for one result row, identified by primary key when possible. */
async function rowAction(setIndex: number, rowIndex: number, action: 'update' | 'insert' | 'delete') {
	const set = last?.sets[setIndex], row = set?.rows[rowIndex];
	if (!last || !set?.source || !row) return;
	const label = { update: 'modifica i valori', insert: 'modifica i valori della copia', delete: 'controlla la riga da eliminare' }[action];
	await openSqlDoc({ spaceId: last.target.spaceId, database: set.source.db },
		`-- ${set.source.db}.${set.source.table}: ${label} e premi Ctrl+Enter per eseguire\n${rowSql(action, set.source, row, last.keys[setIndex])}`);
}

/** Set while an apply is in progress: a second click on "Applica" would run the same INSERTs twice. */
let applying = false;

/**
 * Applies the grid edits after showing the generated SQL, in one transaction. Each UPDATE/DELETE must hit exactly one
 * row, otherwise the row changed since it was read and everything is rolled back.
 */
async function applyGrid(store: Store, sessions: Sessions, m: { id: number; set: number; changes: GridChanges }) {
	const run = last, set = run?.sets[m.set], keys = run?.keys[m.set];
	if (applying || !run || run.id !== m.id || !set?.source || !keys?.length || !keys.every(k => set.source!.columns.includes(k))) return;
	const stmts = gridSql(set.source, keys, set.rows, m.changes ?? {});
	if (!stmts.length) return;
	applying = true;
	try {
		const s = await sessions.open(run.target.spaceId);
		if (!s) return;
		const conn = await s.getMysql();
		const [[info]] = await conn.query<any[]>('SELECT @@SESSION.sql_mode AS mode, (SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?) AS engine',
			[set.source.db, set.source.table]);
		// literal() escapes with backslashes: with this mode they would be taken literally and a quote in the data could end the string.
		if (/NO_BACKSLASH_ESCAPES/i.test(String(info?.mode))) throw new Error('Il server usa sql_mode NO_BACKSLASH_ESCAPES: la modifica in griglia non è supportata.');
		const atomic = String(info?.engine).toLowerCase() === 'innodb';
		const text = stmts.join(';\n') + ';';
		const pick = await vscode.window.showWarningMessage(`Applicare ${stmts.length} modifiche a ${set.source.table}?`, {
			modal: true,
			detail: (atomic ? '' : `Attenzione: la tabella usa ${info?.engine ?? 'un motore sconosciuto'}, senza transazioni. Se un'istruzione fallisce, le precedenti restano applicate.\n\n`)
				+ (text.length > 2000 ? text.slice(0, 2000) + '\n…' : text),
		}, 'Applica', "Apri nell'editor");
		// No START TRANSACTION here: if a statement failed, the transaction would stay open on the shared connection.
		if (pick === "Apri nell'editor") return openSqlDoc({ spaceId: run.target.spaceId, database: set.source.db }, `-- eseguite in sequenza, senza transazione\n${text}\n`);
		if (pick !== 'Applica') return;
		await conn.beginTransaction();
		try {
			for (const sql of stmts) {
				const [r] = await conn.query<any>(sql);
				if (!sql.startsWith('INSERT') && r.affectedRows !== 1) throw new Error(`Riga non trovata (modificata o eliminata nel frattempo?):\n${sql}`);
			}
			await conn.commit();
		} catch (e: any) {
			await conn.rollback().catch(() => undefined);
			throw new Error(`${e?.sqlMessage ?? e?.message ?? e}\n${atomic ? 'Nessuna modifica applicata.' : 'Le istruzioni precedenti potrebbero essere già applicate (tabella senza transazioni).'}`);
		}
	} finally {
		applying = false;
	}
	vscode.window.setStatusBarMessage(`${stmts.length} modifiche applicate a ${set.source.table}`, 4000);
	if (run !== last) return;
	// Clear the pending edits first: if the reload doesn't happen (risky WHERE declined), they must not be applied twice.
	panel?.webview.postMessage({ type: 'applied' });
	if (run.browsing) return runBrowse(store, sessions);
	if (isReadOnly(run.sql)) return execute(store, sessions, run.target, run.sql);
}

async function onMessage(store: Store, sessions: Sessions, m: any) {
	switch (m?.type) {
		case 'export': return exportSet(m.index, m.format);
		case 'copy': await vscode.env.clipboard.writeText(String(m.text)); return vscode.window.setStatusBarMessage('Copiato negli appunti', 2000);
		case 'rerun': return last && isReadOnly(last.sql) && (last.browsing ? runBrowse(store, sessions) : execute(store, sessions, last.target, last.sql));
		case 'edit': return last && openSqlDoc(last.target, last.sql + '\n');
		case 'history': { const h = history[m.index]; return h && openSqlDoc(h.target, h.sql + '\n'); }
		case 'row': return rowAction(m.set, m.row, m.action);
		case 'apply': return applyGrid(store, sessions, m);
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
input.where { flex: 1; min-width: 200px; font-family: var(--vscode-editor-font-family); }
td.sel { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
td.dirty { background: var(--vscode-diffEditor-insertedTextBackground); }
td.def { color: var(--vscode-descriptionForeground); font-style: italic; }
tr.del td:not(.acts) { text-decoration: line-through; background: var(--vscode-diffEditor-removedTextBackground); }
td input.cell { width: 100%; min-width: 120px; padding: 1px 4px; font-family: inherit; }`,
	`<div class="bar"><strong id="title"></strong> <span id="meta" class="muted"></span><span class="grow"></span>
<button class="secondary small" id="rerun" title="Esegui di nuovo (solo query di lettura)">&#8635; Riesegui</button>
<button class="secondary small" id="edit" title="Apri questa query in un editor SQL">&#9998; Apri nell'editor</button>
<button class="secondary small" id="back"></button>
<select id="hist" title="Query eseguite in questa sessione: sceglila per riaprirla nell'editor"></select></div>
<div class="bar" id="browse"></div>
<pre class="sql" id="sql"></pre><div id="out"></div>`,
	`
const $ = id => document.getElementById(id);
// views[i]: client filter/sort plus pending grid edits (upd[row][col], del[row], ins[n][col]; a value is a string or null).
let cur, views = [], sel;
const isBin = v => !!v && typeof v === 'object' && v.type === 'Buffer';
const fmt = v => v === null || v === undefined ? null : typeof v === 'object' ? (isBin(v) ? '[binario ' + (v.data?.length ?? 0) + ' byte]' : JSON.stringify(v)) : String(v);
const td = (v, c, cls = '') => { const s = fmt(v); return '<td data-c="' + c + '" class="' + (s === null ? 'null ' : '') + cls + '"' + (s === null ? '>NULL' : ' title="' + esc(s) + '">' + esc(s)) + '</td>'; };
const pending = i => { const v = views[i]; return v ? Object.keys(v.upd).length + Object.keys(v.del).length + v.ins.length : 0; };
const busy = () => views.some((_, i) => pending(i)) && ($('meta').textContent = 'Applica o annulla prima le modifiche', true);
/** Cell under the event: set, row kind (r = read row, n = new row), row/new index, column. */
function at(e) {
	const el = e.target.closest('td[data-c]');
	if (!el) return;
	const tr = el.closest('tr'), isNew = tr.dataset.n !== undefined;
	return { el, i: setOf(e), tr: isNew ? 'n' : 'r', k: Number(isNew ? tr.dataset.n : tr.dataset.r), c: Number(el.dataset.c) };
}
function valueAt(p) {
	const v = views[p.i], o = p.tr === 'n' ? v.ins[p.k] : v.upd[p.k] || {};
	return p.c in o ? o[p.c] : p.tr === 'n' ? undefined : cur.sets[p.i].rows[p.k][p.c];
}
/** Records an edit; going back to the original value removes it. Binary cells and deleted rows are not editable. */
function setCell(p, val) {
	const v = views[p.i], orig = p.tr === 'r' ? cur.sets[p.i].rows[p.k][p.c] : undefined;
	if (p.tr === 'n') v.ins[p.k][p.c] = val;
	else if (!v.del[p.k] && !isBin(orig)) {
		const u = v.upd[p.k] ??= {};
		if (val === null ? orig === null || orig === undefined : fmt(orig) === val) delete u[p.c]; else u[p.c] = val;
		if (!Object.keys(u).length) delete v.upd[p.k];
	}
	renderSet(p.i);
}
function startEdit(p) {
	const orig = p.tr === 'r' ? cur.sets[p.i].rows[p.k][p.c] : undefined;
	if (p.tr === 'r' && (views[p.i].del[p.k] || isBin(orig))) return;
	const before = fmt(valueAt(p)) ?? '', inp = document.createElement('input');
	inp.className = 'cell'; inp.value = before;
	p.el.textContent = ''; p.el.appendChild(inp); inp.focus(); inp.select();
	let done = false;
	const finish = save => { if (done) return; done = true; if (save && inp.value !== before) setCell(p, inp.value); else renderSet(p.i); };
	inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
	inp.addEventListener('blur', () => finish(true));
}
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
const GACTS = '<td class="acts"><button data-g="dup" title="Duplica riga (nuova riga da applicare)">&#10697;</button><button data-g="del" title="Elimina la riga, o ripristinala">&#10005;</button></td>';
const NACTS = '<td class="acts"><button data-g="unins" title="Togli la nuova riga">&#10005;</button></td>';
function renderSet(i) {
	const s = cur.sets[i], v = views[i], rows = visible(i), el = document.querySelector('.set[data-i="' + i + '"]');
	el.querySelector('.count').textContent = (v.filter ? rows.length + ' di ' : '') + s.total + ' righe' + (s.total > s.rows.length ? ' (mostrate le prime ' + s.rows.length + ')' : '');
	if (s.grid) {
		const n = pending(i);
		el.querySelector('.apply').textContent = 'Applica' + (n ? ' (' + n + ')' : '');
		el.querySelectorAll('.apply, .undo').forEach(b => b.disabled = !n);
	}
	el.querySelector('thead').innerHTML = '<tr>' + (s.editable ? '<th class="acts"></th>' : '') + s.columns.map((c, ci) => '<th data-c="' + ci + '" title="Ordina">' + esc(c) + arrow(i, ci) + '</th>').join('') + '</tr>';
	el.querySelector('tbody').innerHTML = rows.map(r => {
		const u = v.upd[r] || {};
		return '<tr data-r="' + r + '"' + (v.del[r] ? ' class="del"' : '') + '>' + (s.grid ? GACTS : s.editable ? ACTS : '') +
			s.rows[r].map((x, c) => c in u ? td(u[c], c, 'dirty') : td(x, c)).join('') + '</tr>';
	}).join('') + v.ins.map((n, k) => '<tr data-n="' + k + '">' + NACTS +
		s.columns.map((_, c) => c in n ? td(n[c], c, 'dirty') : '<td data-c="' + c + '" class="def" title="Valore di default della colonna">DEFAULT</td>').join('') + '</tr>').join('');
	if (sel?.i === i) el.querySelector('tr[data-' + sel.tr + '="' + sel.k + '"] td[data-c="' + sel.c + '"]')?.classList.add('sel');
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
	if (m.type === 'applied') {
		// The rows shown are now stale: the grid goes read-only until the query runs again (usually right after this message).
		views.forEach(v => Object.assign(v, { upd: {}, del: {}, ins: [] }));
		document.querySelectorAll('[data-x="add"], [data-x="null"], .undo, .apply').forEach(b => b.remove());
		cur.sets?.forEach((s, i) => { s.grid = false; if (s.info === undefined) renderSet(i); });
		$('meta').textContent = 'modifiche applicate: riesegui la query per vederle';
		return;
	}
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
	views = m.sets.map(() => ({ filter: '', sort: null, upd: {}, del: {}, ins: [] }));
	sel = undefined;
	$('out').innerHTML = m.sets.map((s, i) => s.info !== undefined ? '<p>' + esc(s.info) + '</p>' :
		'<div class="set" data-i="' + i + '"><div class="bar"><span class="muted count"></span>' +
		'<input class="filter" placeholder="Filtra righe mostrate..." style="width: 220px">' +
		(s.grid ? '<button class="secondary small" data-x="add">+ Riga</button>' +
			'<button class="secondary small" data-x="null" title="Imposta a NULL la cella selezionata">NULL</button>' +
			'<button class="secondary small undo" data-x="undo" title="Scarta le modifiche non applicate">Annulla</button>' +
			'<button class="small apply" data-x="apply" title="Mostra l\\'SQL e lo esegue in una transazione">Applica</button>' +
			'<span class="grow"></span><span class="muted">doppio clic modifica la cella, Ctrl+C la copia</span>'
		: (s.editable ? '<span class="muted">&#9998; modifica, &#10697; duplica, &#10005; elimina: aprono l\\'SQL da confermare (senza chiave primaria la griglia è in sola lettura)</span>' : '') +
			'<span class="grow"></span><span class="muted">doppio clic su una cella la copia</span>') +
		'<button class="secondary small" data-x="copy" title="Copia le righe mostrate (incollabili in Excel)">Copia</button>' +
		'<button class="secondary small" data-x="csv">CSV</button><button class="secondary small" data-x="json">JSON</button></div>' +
		'<div class="wrap"><table><thead></thead><tbody></tbody></table></div></div>').join('');
	m.sets.forEach((s, i) => s.info === undefined && renderSet(i));
});
const setOf = e => { const el = e.target.closest('.set'); return el ? Number(el.dataset.i) : -1; };
document.addEventListener('click', e => {
	const t = e.target, i = setOf(e);
	if (t.id === 'rerun') return busy() || vscode.postMessage({ type: 'rerun' });
	if (t.id === 'edit') return vscode.postMessage({ type: 'edit' });
	if (t.id === 'back') return busy() || vscode.postMessage({ type: 'browse' });
	if (t.id === 'prev' || t.id === 'next') return busy() || vscode.postMessage({ type: 'browse', delta: t.id === 'next' ? 1 : -1 });
	const g = t.closest('td.acts button[data-g]');
	if (g) {
		const v = views[i], s = cur.sets[i], tr = g.closest('tr'), r = Number(tr.dataset.r);
		if (g.dataset.g === 'del') { if (v.del[r]) delete v.del[r]; else { v.del[r] = true; delete v.upd[r]; } }
		// Duplicate without primary key (AUTO_INCREMENT or the user fills it) and binary columns, which can't be edited here.
		if (g.dataset.g === 'dup') v.ins.push(Object.fromEntries(s.rows[r].map((x, c) => [c, x])
			.filter(([c, x]) => !s.pk.includes(s.source.columns[c]) && !isBin(x)).map(([c, x]) => [c, fmt(x)])));
		if (g.dataset.g === 'unins') { v.ins.splice(Number(tr.dataset.n), 1); sel = undefined; }
		return renderSet(i);
	}
	const act = t.closest('td.acts button');
	if (act) return vscode.postMessage({ type: 'row', set: i, row: Number(act.closest('tr').dataset.r), action: act.dataset.a });
	const th = t.closest('th[data-c]');
	if (th) {
		const c = Number(th.dataset.c);
		if (cur.browse) return busy() || vscode.postMessage({ type: 'browse', order: cur.sets[i].columns[c] });
		const s = views[i].sort;
		views[i].sort = s?.c === c ? (s.d > 0 ? { c, d: -1 } : null) : { c, d: 1 };
		return renderSet(i);
	}
	const x = t.dataset?.x;
	if (x === 'csv' || x === 'json') return vscode.postMessage({ type: 'export', index: i, format: x });
	if (x === 'copy') {
		const s = cur.sets[i];
		const tsv = [s.columns, ...visible(i).map(r => s.rows[r].map(v => fmt(v) ?? 'NULL'))].map(r => r.map(v => String(v).replace(/[\\t\\r\\n]+/g, ' ')).join('\\t')).join('\\n');
		return vscode.postMessage({ type: 'copy', text: tsv });
	}
	const v = views[i];
	if (x === 'add') { v.ins.push({}); return renderSet(i); }
	if (x === 'null') return sel?.i === i && setCell(sel, null);
	if (x === 'undo') { Object.assign(v, { upd: {}, del: {}, ins: [] }); return renderSet(i); }
	if (x === 'apply') return vscode.postMessage({ type: 'apply', id: cur.id, set: i, changes: {
		updates: Object.entries(v.upd).map(([row, values]) => ({ row: Number(row), values })),
		deletes: Object.keys(v.del).map(Number), inserts: v.ins } });
	const p = t.tagName !== 'INPUT' && at(e);
	if (p) {
		document.querySelectorAll('td.sel').forEach(c => c.classList.remove('sel'));
		p.el.classList.add('sel');
		sel = { i: p.i, tr: p.tr, k: p.k, c: p.c };
	}
});
document.addEventListener('dblclick', e => {
	const p = e.target.tagName !== 'INPUT' && at(e);
	if (!p) return;
	if (cur.sets[p.i].grid) return startEdit(p);
	vscode.postMessage({ type: 'copy', text: fmt(valueAt(p)) ?? 'NULL' });
});
document.addEventListener('input', e => {
	if (!e.target.classList.contains('filter')) return;
	const i = setOf(e);
	views[i].filter = e.target.value;
	renderSet(i);
});
document.addEventListener('keydown', e => {
	if (e.target.id === 'where' && e.key === 'Enter') return busy() || vscode.postMessage({ type: 'browse', where: e.target.value });
	if ((e.ctrlKey || e.metaKey) && e.key === 'c' && sel && e.target.tagName !== 'INPUT' && !String(getSelection())) {
		const el = document.querySelector('.set[data-i="' + sel.i + '"] tr[data-' + sel.tr + '="' + sel.k + '"] td[data-c="' + sel.c + '"]');
		if (el) { e.preventDefault(); vscode.postMessage({ type: 'copy', text: fmt(valueAt(sel)) ?? 'NULL' }); }
	}
});
$('hist').addEventListener('change', e => {
	if (e.target.value !== '') vscode.postMessage({ type: 'history', index: Number(e.target.value) });
	e.target.value = '';
});`);
	return panel;
}
