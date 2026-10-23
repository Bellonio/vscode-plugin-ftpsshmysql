import * as vscode from 'vscode';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Connection } from 'mysql2/promise';
import { Session, Sessions } from '../session';
import { Node } from '../tree';
import { page } from '../webview/html';
import { confirmRisky, primaryKey } from './results';
import { createIfNotExists, dumpFooter, dumpHeader, ident, insertBatch, InsertVerb, jsonRows, toCsv, viewDefinition } from './sqlgen';

interface Obj { name: string; view: boolean }
interface Options {
	tables: string[];
	format: 'sql' | 'csv' | 'json';
	gzip: boolean;
	/** Rows per table: undefined = all. */
	limit?: number;
	offset: number;
	/** Only with a single table. */
	where: string;
	content: 'both' | 'structure' | 'data';
	drop: boolean;
	createDb: boolean;
	autoIncrement: boolean;
	insert: InsertVerb;
	perInsert: number;
	transaction: boolean;
}

const panels = new Map<string, vscode.WebviewPanel>();

/** Export page of a database (tables preselected from the clicked node): SQL, CSV or JSON, optionally gzipped. */
export async function openExport(sessions: Sessions, node: Node) {
	if (node?.kind !== 'table' && node?.kind !== 'database') return;
	const { spaceId, database: db } = node;
	const table = node.kind === 'table' ? node.table : undefined;
	const key = `${spaceId}|${db}`;
	const existing = panels.get(key);
	if (existing) {
		existing.reveal();
		existing.webview.postMessage({ type: 'select', table });
		return;
	}
	const s = await sessions.open(spaceId);
	if (!s) return;
	const objects: Obj[] = (await query(await s.getMysql(), `SHOW FULL TABLES FROM ${ident(db)}`)).map(r => ({ name: String(r[0]), view: r[1] === 'VIEW' }));
	const panel = vscode.window.createWebviewPanel('wsm.export', `Esporta: ${db}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
	panels.set(key, panel);
	panel.onDidDispose(() => panels.delete(key));
	const status = (ok: boolean, text: string) => panel.webview.postMessage({ type: 'status', ok, text });
	panel.webview.html = html(panel.webview);
	panel.webview.onDidReceiveMessage(async msg => {
		try {
			if (msg.type === 'ready') panel.webview.postMessage({ type: 'init', objects, table, db, space: s.space.name });
			else if (msg.type === 'export') {
				const opts = sanitize(msg.options, objects);
				if (typeof opts === 'string') return status(false, opts);
				const session = await sessions.open(spaceId);
				if (session) status(true, await run(session, db, objects.filter(o => opts.tables.includes(o.name)), opts));
			}
		} catch (e: any) {
			status(false, e?.sqlMessage ?? e?.message ?? String(e));
		}
	});
}

const query = async (conn: Connection, sql: string) => (await conn.query<any[]>({ sql, rowsAsArray: true }))[0];
const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : undefined;

/** The webview is not trusted: only known tables and whitelisted values go further. Error text when invalid. */
function sanitize(o: any, objects: Obj[]): Options | string {
	const tables = (Array.isArray(o?.tables) ? o.tables : []).filter((t: unknown) => objects.some(x => x.name === t));
	if (!tables.length) return 'Seleziona almeno una tabella.';
	const format = ['sql', 'csv', 'json'].includes(o.format) ? o.format : 'sql';
	const limit = o.limit === null || o.limit === undefined ? undefined : int(o.limit, 1, Number.MAX_SAFE_INTEGER);
	if (o.limit != null && limit === undefined) return 'Numero di righe non valido.';
	const offset = int(o.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
	if (offset === undefined) return 'Riga di partenza non valida.';
	const perInsert = int(o.perInsert, 1, 100000);
	if (format === 'sql' && perInsert === undefined) return 'Righe per INSERT: da 1 a 100000.';
	const content = ['both', 'structure', 'data'].includes(o.content) ? o.content : 'both';
	return {
		tables, format, offset, limit, content,
		gzip: !!o.gzip,
		where: tables.length === 1 && typeof o.where === 'string' ? o.where.trim() : '',
		drop: !!o.drop && content !== 'data',
		createDb: !!o.createDb,
		autoIncrement: !!o.autoIncrement,
		insert: (['INSERT', 'INSERT IGNORE', 'REPLACE'] as const).find(v => v === o.insert) ?? 'INSERT',
		perInsert: perInsert ?? 500,
		transaction: !!o.transaction,
	};
}

/**
 * Writes the export and returns the summary shown in the page. Cancelled or failed exports leave no partial file.
 * ponytail: LIMIT/OFFSET blocks on the shared connection, without a consistent snapshot (a transaction would get in the
 * way of grid edits). Fine for small databases; big ones need keyset paging on a dedicated connection.
 */
async function run(s: Session, db: string, objects: Obj[], o: Options): Promise<string> {
	const sql = o.format === 'sql';
	const one = objects.length === 1 ? objects[0].name : undefined;
	const gz = o.gzip ? '.gz' : '';
	// SQL is one file; CSV/JSON one file per table, so several tables go into a folder.
	let files: { path: string; objects: Obj[] }[];
	if (sql || one) {
		const uri = await vscode.window.showSaveDialog({
			title: 'Esporta', defaultUri: vscode.Uri.file(join(homedir(), `${sql ? db + (one ? '.' + one : '') : one}.${o.format}${gz}`)),
			filters: { [o.format.toUpperCase()]: [o.format + gz] },
		});
		if (!uri) return 'Esportazione annullata.';
		files = [{ path: uri.fsPath, objects }];
	} else {
		const [dir] = await vscode.window.showOpenDialog({ title: `Cartella in cui salvare un file .${o.format} per tabella`, canSelectFolders: true, canSelectFiles: false, openLabel: 'Esporta qui' }) ?? [];
		if (!dir) return 'Esportazione annullata.';
		files = objects.map(x => ({ path: join(dir.fsPath, `${x.name}.${o.format}${gz}`), objects: [x] }));
	}
	const where = o.where ? `\nWHERE ${o.where}` : '';
	if (where && !await confirmRisky(`SELECT 1 FROM t${where}`)) return 'Esportazione annullata.';
	const conn = await s.getMysql();
	let rows = 0;
	const written: string[] = [];
	const cancelled = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Esportazione', cancellable: true }, async (progress, token) => {
		/** Rows of one table in blocks, honoring start row, row count, WHERE; ordered by primary key so OFFSET paging is stable. */
		async function* blocks(name: string, columns: string[]) {
			const full = `${ident(db)}.${ident(name)}`;
			const pk = await primaryKey(conn, { db, table: name, columns }).catch(() => []);
			const select = `SELECT ${columns.map(ident).join(', ')} FROM ${full}${where}${pk.length ? `\nORDER BY ${pk.map(ident).join(', ')}` : ''}`;
			const size = sql ? o.perInsert : 1000;
			for (let left = o.limit ?? Infinity, offset = o.offset; left > 0 && !token.isCancellationRequested;) {
				const n = Math.min(size, left);
				const block = await query(conn, `${select}\nLIMIT ${n} OFFSET ${offset}`);
				rows += block.length;
				if (block.length) yield block;
				if (block.length < n) return;
				left -= n; offset += n;
			}
		}
		/** CSV / JSON, one table per file. */
		async function* content(list: Obj[]): AsyncGenerator<string> {
			for (const x of list) {
				if (token.isCancellationRequested) return;
				progress.report({ message: x.name, increment: 100 / objects.length });
				const columns = (await query(conn, `SHOW COLUMNS FROM ${ident(db)}.${ident(x.name)}`)).map(c => String(c[0]));
				if (o.format === 'csv') {
					yield toCsv(columns, [], true);
					for await (const b of blocks(x.name, columns)) yield toCsv(columns, b, false);
				} else {
					let first = true;
					yield '[';
					for await (const b of blocks(x.name, columns)) {
						yield (first ? '\n' : ',\n') + jsonRows(columns, b).map(r => JSON.stringify(r)).join(',\n');
						first = false;
					}
					yield '\n]\n';
				}
			}
		}
		async function* sqlDump(list: Obj[]): AsyncGenerator<string> {
			yield dumpHeader(`${db}${one ? '.' + one : ''}`);
			if (o.createDb) yield `${createIfNotExists(String((await query(conn, `SHOW CREATE DATABASE ${ident(db)}`))[0][1]))};\nUSE ${ident(db)};\n\n`;
			if (o.transaction) yield 'START TRANSACTION;\n\n';
			// Views after tables: they are built on them. View data is not dumped, it comes from the tables.
			for (const x of [...list].sort((a, b) => +a.view - +b.view)) {
				if (token.isCancellationRequested) return;
				progress.report({ message: x.name, increment: 100 / objects.length });
				const t = ident(x.name), full = `${ident(db)}.${t}`;
				if (x.view) {
					if (o.content === 'data') continue;
					const [r] = await query(conn, `SHOW CREATE VIEW ${full}`);
					yield `${o.drop ? `DROP VIEW IF EXISTS ${t};\n` : ''}${viewDefinition(String(r[1]))};\n\n`;
					continue;
				}
				if (o.content !== 'data') {
					const [r] = await query(conn, `SHOW CREATE TABLE ${full}`);
					yield `${o.drop ? `DROP TABLE IF EXISTS ${t};\n` : ''}${createIfNotExists(String(r[1]), o.autoIncrement)};\n\n`;
				}
				if (o.content === 'structure') continue;
				// Generated columns can't be inserted: mysqldump leaves them out too.
				const columns = (await query(conn, `SHOW COLUMNS FROM ${full}`)).filter(c => !/GENERATED/i.test(String(c[5]))).map(c => String(c[0]));
				for await (const b of blocks(x.name, columns)) yield insertBatch(x.name, columns, b, o.insert);
				yield '\n';
			}
			if (o.transaction) yield 'COMMIT;\n\n';
			yield dumpFooter;
		}
		for (const f of files) {
			if (token.isCancellationRequested) break;
			const gen = sql ? sqlDump(f.objects) : content(f.objects);
			try {
				const source = Readable.from(gen);
				await (o.gzip ? pipeline(source, createGzip(), createWriteStream(f.path)) : pipeline(source, createWriteStream(f.path)));
				written.push(f.path);
			} catch (e) {
				await unlink(f.path).catch(() => undefined);
				throw e;
			} finally {
				// A partial file is useless and could be mistaken for a full one.
				if (token.isCancellationRequested) await unlink(f.path).catch(() => undefined);
			}
		}
		return token.isCancellationRequested;
	});
	if (cancelled) {
		await Promise.all(written.map(p => unlink(p).catch(() => undefined)));
		return 'Esportazione interrotta: nessun file salvato.';
	}
	return `Esportati ${objects.length} oggetti, ${rows} righe in ${files.length === 1 ? files[0].path : files.length + ' file in ' + join(files[0].path, '..')}`;
}

function html(webview: vscode.Webview): string {
	const css = `
form { max-width: 720px; }
fieldset { border: 1px solid var(--vscode-panel-border); margin: 14px 0; padding: 10px 14px; }
legend { padding: 0 6px; font-weight: 600; }
label.row { display: grid; grid-template-columns: 170px 1fr; align-items: center; gap: 10px; margin: 6px 0; }
label.check { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
input[type=text], input[type=number], select { width: 100%; }
#tables { max-height: 260px; overflow: auto; columns: 2; }
.tools { display: flex; gap: 8px; margin-bottom: 6px; }
.tools button { padding: 2px 10px; }
.actions { display: flex; gap: 8px; margin-top: 16px; }
#status { white-space: pre-wrap; margin-top: 12px; }
.hidden { display: none !important; }`;
	const body = `
<h2>Esporta <span id="title"></span></h2>
<form id="f" autocomplete="off">
<fieldset><legend>Tabelle</legend>
	<div class="tools"><button type="button" class="secondary" id="all">Tutte</button><button type="button" class="secondary" id="none">Nessuna</button><span id="count" class="muted"></span></div>
	<div id="tables"></div>
</fieldset>

<fieldset><legend>Formato</legend>
	<label class="row">Formato <select id="format"><option value="sql">SQL</option><option value="csv">CSV (un file per tabella)</option><option value="json">JSON (un file per tabella)</option></select></label>
	<label class="check"><input type="checkbox" id="gzip"> Comprimi (gzip)</label>
</fieldset>

<fieldset><legend>Righe</legend>
	<label class="check"><input type="checkbox" id="allRows" checked> Tutte le righe</label>
	<label class="row someRows">Numero di righe <input type="number" id="limit" min="1" value="1000"></label>
	<label class="row someRows">A partire dalla riga <input type="number" id="offset" min="0" value="0"></label>
	<label class="row" id="whereRow">WHERE (una sola tabella) <input type="text" id="where" placeholder="es. created_at >= '2024-01-01'"></label>
</fieldset>

<fieldset id="sqlBox"><legend>Opzioni SQL</legend>
	<label class="row">Contenuto <select id="content"><option value="both">Struttura e dati</option><option value="structure">Solo struttura</option><option value="data">Solo dati</option></select></label>
	<label class="check"><input type="checkbox" id="createDb"> CREATE DATABASE IF NOT EXISTS e USE</label>
	<label class="check struct"><input type="checkbox" id="drop"> DROP TABLE / DROP VIEW IF EXISTS (sostituisce gli oggetti esistenti all'import)</label>
	<label class="check struct"><input type="checkbox" id="autoIncrement" checked> Valore AUTO_INCREMENT nel CREATE TABLE</label>
	<p class="muted struct">CREATE TABLE è sempre con IF NOT EXISTS.</p>
	<label class="row data">Istruzione <select id="insert"><option>INSERT</option><option>INSERT IGNORE</option><option>REPLACE</option></select></label>
	<label class="row data">Righe per INSERT <input type="number" id="perInsert" min="1" max="100000" value="500"></label>
	<label class="check"><input type="checkbox" id="transaction"> Racchiudi in una transazione (START TRANSACTION / COMMIT)</label>
</fieldset>

<div class="actions"><button type="submit">Esporta...</button></div>
<div id="status"></div>
</form>`;
	const script = `
const $ = id => document.getElementById(id);
const boxes = () => [...document.querySelectorAll('#tables input')];
const picked = () => boxes().filter(b => b.checked).map(b => b.value);

function sync() {
	const sql = $('format').value === 'sql', n = picked().length, content = $('content').value;
	$('sqlBox').classList.toggle('hidden', !sql);
	document.querySelectorAll('.someRows').forEach(e => e.classList.toggle('hidden', $('allRows').checked));
	$('whereRow').classList.toggle('hidden', n !== 1);
	document.querySelectorAll('.struct').forEach(e => e.classList.toggle('hidden', content === 'data'));
	document.querySelectorAll('.data').forEach(e => e.classList.toggle('hidden', content === 'structure'));
	$('count').textContent = n + ' di ' + boxes().length + ' selezionate';
}
document.addEventListener('change', sync);
$('all').addEventListener('click', () => { boxes().forEach(b => b.checked = true); sync(); });
$('none').addEventListener('click', () => { boxes().forEach(b => b.checked = false); sync(); });

const num = id => $(id).value === '' ? NaN : Number($(id).value);
$('f').addEventListener('submit', e => {
	e.preventDefault();
	$('status').textContent = '';
	vscode.postMessage({ type: 'export', options: {
		tables: picked(), format: $('format').value, gzip: $('gzip').checked,
		limit: $('allRows').checked ? null : num('limit'), offset: $('allRows').checked ? 0 : num('offset'), where: $('where').value,
		content: $('content').value, createDb: $('createDb').checked, drop: $('drop').checked, autoIncrement: $('autoIncrement').checked,
		insert: $('insert').value, perInsert: num('perInsert'), transaction: $('transaction').checked,
	} });
});

function select(table) {
	if (table) boxes().forEach(b => b.checked = b.value === table);
	sync();
}
window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'status') { $('status').textContent = m.text; $('status').className = m.ok ? 'muted' : 'error'; }
	if (m.type === 'select') select(m.table);
	if (m.type === 'init') {
		$('title').textContent = m.db + ' (' + m.space + ')';
		$('tables').innerHTML = m.objects.map(o => '<label class="check"><input type="checkbox" checked value="' + esc(o.name) + '"> ' + esc(o.name) + (o.view ? ' <span class="muted">(vista)</span>' : '') + '</label>').join('');
		select(m.table);
	}
});
sync();
vscode.postMessage({ type: 'ready' });`;
	return page(webview, 'Esporta', css, body, script);
}
