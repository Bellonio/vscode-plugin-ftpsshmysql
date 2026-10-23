// SQL helpers without vscode or a connection, so they can be unit tested.

/** Quotes a MySQL identifier. */
export const ident = (name: string) => '`' + name.replace(/`/g, '``') + '`';

/** Replaces comments with a space and string literals with '…', so keywords inside them are ignored. */
export function stripSql(sql: string): string {
	return sql.replace(/'(?:\\[\s\S]|''|[^'\\])*'|"(?:\\[\s\S]|""|[^"\\])*"|`(?:``|[^`])*`|\/\*[\s\S]*?\*\/|(?:--(?=\s|$)|#)[^\n]*/g,
		m => m[0] === '`' ? m : m[0] === "'" || m[0] === '"' ? "'…'" : ' ');
}

/**
 * Statements worth a confirmation: DROP, TRUNCATE, ALTER ... DROP, DELETE/UPDATE without WHERE.
 * ponytail: split on ';' after stripping literals, so DELIMITER blocks (procedures) are not understood; a statement
 * splitter is planned for the .sql import.
 */
export function riskyStatements(sql: string): string[] {
	return stripSql(sql).split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(s =>
		/^(DROP|TRUNCATE)\b/i.test(s) || /^ALTER\b.*\bDROP\b/i.test(s) || (/^(DELETE|UPDATE)\b/i.test(s) && !/\bWHERE\b/i.test(s)));
}

/** True when a statement changes the structure shown in the tree (databases, tables, columns, indexes). */
export const changesSchema = (sql: string) =>
	stripSql(sql).split(';').some(s => /^(CREATE|ALTER|DROP|RENAME)\b/i.test(s.trim()));

/** True when every statement only reads (SELECT/SHOW/...), so it is safe to run again with one click. WITH is excluded: it can lead a DELETE/UPDATE. */
export function isReadOnly(sql: string): boolean {
	const parts = stripSql(sql).split(';').map(s => s.trim()).filter(Boolean);
	return parts.length > 0 && parts.every(s => /^\(?\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i.test(s) && !/^EXPLAIN\s+ANALYZE\b|\bINTO\s+(OUTFILE|DUMPFILE)\b|\bFOR\s+UPDATE\b/i.test(s));
}

/** RFC 4180 CSV (comma, CRLF). NULL becomes an empty field, binary data base64. */
export function toCsv(columns: string[], rows: unknown[][], header = true): string {
	const field = (v: unknown) => {
		const s = v === null || v === undefined ? '' : Buffer.isBuffer(v) ? v.toString('base64') : typeof v === 'object' ? JSON.stringify(v) : String(v);
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	};
	return (header ? [columns, ...rows] : rows).map(r => r.map(field).join(',')).join('\r\n') + '\r\n';
}

/** Rows as objects keyed by column name. Binary data base64. */
export const jsonRows = (columns: string[], rows: unknown[][]) =>
	rows.map(r => Object.fromEntries(columns.map((c, i) => [c, Buffer.isBuffer(r[i]) ? (r[i] as Buffer).toString('base64') : r[i]])));

export const toJson = (columns: string[], rows: unknown[][]) => JSON.stringify(jsonRows(columns, rows), null, 2);

/** SQL literal for a value read with dateStrings/bigNumberStrings: NULL, numbers as-is, Buffer as X'..', the rest quoted. */
export function literal(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
	const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
	return "'" + s.replace(/[\\'\0\n\r\x1a]/g, c => '\\' + ({ '\0': '0', '\n': 'n', '\r': 'r', '\x1a': 'Z' }[c] ?? c)) + "'";
}

/** Dump header: backslash escaping and AUTO_INCREMENT id 0 kept whatever the server sql_mode; checks off while loading. */
export const dumpHeader = (what: string) => `-- WebSpace Manager dump: ${what}\n-- ${new Date().toISOString()}\n\n`
	+ "SET NAMES utf8mb4;\nSET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n"
	+ 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;\nSET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;\n\n';
export const dumpFooter = 'SET SQL_MODE=@OLD_SQL_MODE;\nSET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;\nSET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;\n';

/** SHOW CREATE TABLE / DATABASE output made safe to run on an existing database, optionally without the AUTO_INCREMENT counter. */
export const createIfNotExists = (create: string, autoIncrement = true) => {
	const s = create.replace(/^CREATE (TABLE|DATABASE) /i, 'CREATE $1 IF NOT EXISTS ');
	return autoIncrement ? s : s.replace(/ AUTO_INCREMENT=\d+/, '');
};

/**
 * SHOW CREATE VIEW output without DEFINER / SQL SECURITY DEFINER (the definer user often doesn't exist on the target
 * server), as CREATE OR REPLACE: like the tables' IF NOT EXISTS, importing on an existing database doesn't stop here.
 */
export const viewDefinition = (createView: string) =>
	createView.replace(/ DEFINER=(`(?:``|[^`])*`|'[^']*'|\S+)@(`(?:``|[^`])*`|'[^']*'|\S+)/i, '').replace(/ SQL SECURITY DEFINER/i, '')
		.replace(/^CREATE (?!OR REPLACE )/i, 'CREATE OR REPLACE ');

/**
 * Views in creation order: each one after the views its definition names. Cycles keep the given order.
 * ponytail: a name is "used" when its quoted form appears in the definition (a same-named column can only reorder).
 */
export function orderViews<T extends { name: string; def: string }>(views: T[]): T[] {
	const out: T[] = [], left = [...views];
	while (left.length) {
		const i = left.findIndex(v => !left.some(w => w !== v && v.def.includes(ident(w.name))));
		out.push(...left.splice(Math.max(i, 0), 1));
	}
	return out;
}

/** SHOW COLUMNS "Extra" of a generated column. Not DEFAULT_GENERATED (MySQL 8: expression default such as CURRENT_TIMESTAMP). */
export const isGenerated = (extra: string) => /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra);

/** Table name usable as a file name on Windows too: no path separators or reserved characters, no reserved device names. */
export function safeFileName(name: string): string {
	const s = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '_') || '_';
	return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s) ? '_' + s : s;
}

export type InsertVerb = 'INSERT' | 'INSERT IGNORE' | 'REPLACE';

/** One multi-row INSERT for a block of rows read with dateStrings/bigNumberStrings. */
export function insertBatch(table: string, columns: string[], rows: unknown[][], verb: InsertVerb = 'INSERT'): string {
	return `${verb} INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES\n${rows.map(r => `(${r.map(literal).join(', ')})`).join(',\n')};\n`;
}

/** Row source of a result set, so a row can be turned back into UPDATE/INSERT/DELETE. */
export interface RowSource { db: string; table: string; columns: string[] }

/**
 * WHERE clause for one row: by primary key when all its columns are in the result, otherwise by every column
 * (the caller adds LIMIT 1, so a duplicate row is touched only once).
 */
function rowWhere(src: RowSource, row: unknown[], keys: string[]): string {
	const byKey = keys.length > 0 && keys.every(k => src.columns.includes(k));
	const cols = byKey ? keys : src.columns;
	return cols.map(c => {
		const v = row[src.columns.indexOf(c)];
		return `${ident(c)} ${v === null || v === undefined ? 'IS NULL' : '= ' + literal(v)}`;
	}).join('\n\tAND ');
}

/** UPDATE / INSERT / DELETE of a result row, to be reviewed by the user before running it. */
export function rowSql(action: 'update' | 'insert' | 'delete', src: RowSource, row: unknown[], keys: string[]): string {
	const t = `${ident(src.db)}.${ident(src.table)}`;
	const noKey = keys.length === 0 || !keys.every(k => src.columns.includes(k))
		? '-- Attenzione: chiave primaria assente nel risultato, la riga è identificata da tutte le colonne\n' : '';
	switch (action) {
		case 'update':
			return `${noKey}UPDATE ${t} SET\n${src.columns.filter(c => !keys.includes(c)).map(c => `\t${ident(c)} = ${literal(row[src.columns.indexOf(c)])}`).join(',\n')}\nWHERE ${rowWhere(src, row, keys)}\nLIMIT 1;\n`;
		case 'delete':
			return `${noKey}DELETE FROM ${t}\nWHERE ${rowWhere(src, row, keys)}\nLIMIT 1;\n`;
		case 'insert': {
			// Duplicate: primary key columns are left out so AUTO_INCREMENT (or the user) assigns a new one.
			const cols = src.columns.filter(c => !keys.includes(c));
			return `INSERT INTO ${t} (${cols.map(ident).join(', ')})\nVALUES (\n${cols.map(c => `\t${literal(row[src.columns.indexOf(c)])}`).join(',\n')}\n);\n`;
		}
	}
}

/** Grid edits sent by the results webview: values by column index, null = NULL; insert columns left out take their DEFAULT. */
export interface GridChanges {
	updates: { row: number; values: Record<string, string | null> }[];
	inserts: Record<string, string | null>[];
	deletes: number[];
}

/**
 * Statements applying grid edits, rows identified by the primary key values they had when read. The input comes from
 * the webview, so out-of-range rows/columns and non-string values are dropped. Order: DELETE, UPDATE, INSERT.
 */
export function gridSql(src: RowSource, keys: string[], rows: unknown[][], ch: GridChanges): string[] {
	const t = `${ident(src.db)}.${ident(src.table)}`;
	const okRow = (r: unknown): r is number => Number.isInteger(r) && (r as number) >= 0 && (r as number) < rows.length;
	const cols = (v: Record<string, unknown> | undefined) => Object.entries(v ?? {})
		.filter(([c, x]) => /^\d+$/.test(c) && +c < src.columns.length && (x === null || typeof x === 'string'))
		.map(([c, x]) => [src.columns[+c], x] as [string, string | null]);
	const deleted = new Set((ch.deletes ?? []).filter(okRow));
	return [
		...[...deleted].map(r => `DELETE FROM ${t} WHERE ${rowWhere(src, rows[r], keys)} LIMIT 1`),
		...(ch.updates ?? []).filter(u => okRow(u?.row) && !deleted.has(u.row)).map(u => [u.row, cols(u.values)] as const).filter(([, c]) => c.length)
			.map(([r, c]) => `UPDATE ${t} SET ${c.map(([n, v]) => `${ident(n)} = ${literal(v)}`).join(', ')} WHERE ${rowWhere(src, rows[r], keys)} LIMIT 1`),
		...(ch.inserts ?? []).map(cols).map(c => `INSERT INTO ${t} (${c.map(([n]) => ident(n)).join(', ')}) VALUES (${c.map(([, v]) => literal(v)).join(', ')})`),
	];
}

/** Definition of one column taken from SHOW CREATE TABLE (e.g. "varchar(255) NOT NULL DEFAULT ''"), without name and trailing comma. */
export function columnDefinition(createTable: string, column: string): string | undefined {
	const prefix = ident(column) + ' ';
	const line = createTable.split('\n').map(l => l.trim()).find(l => l.startsWith(prefix));
	return line?.slice(prefix.length).replace(/,$/, '');
}
