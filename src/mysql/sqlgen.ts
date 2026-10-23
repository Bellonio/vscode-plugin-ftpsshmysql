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

/** True when every statement only reads (SELECT/SHOW/...), so it is safe to run again with one click. WITH is excluded: it can lead a DELETE/UPDATE. */
export function isReadOnly(sql: string): boolean {
	const parts = stripSql(sql).split(';').map(s => s.trim()).filter(Boolean);
	return parts.length > 0 && parts.every(s => /^\(?\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i.test(s) && !/^EXPLAIN\s+ANALYZE\b|\bINTO\s+(OUTFILE|DUMPFILE)\b|\bFOR\s+UPDATE\b/i.test(s));
}

/** RFC 4180 CSV (comma, CRLF). NULL becomes an empty field, binary data base64. */
export function toCsv(columns: string[], rows: unknown[][]): string {
	const field = (v: unknown) => {
		const s = v === null || v === undefined ? '' : Buffer.isBuffer(v) ? v.toString('base64') : typeof v === 'object' ? JSON.stringify(v) : String(v);
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	};
	return [columns, ...rows].map(r => r.map(field).join(',')).join('\r\n') + '\r\n';
}

/** Rows as objects keyed by column name. Binary data base64. */
export function toJson(columns: string[], rows: unknown[][]): string {
	return JSON.stringify(rows.map(r => Object.fromEntries(columns.map((c, i) => [c, Buffer.isBuffer(r[i]) ? (r[i] as Buffer).toString('base64') : r[i]]))), null, 2);
}

/** SQL literal for a value read with dateStrings/bigNumberStrings: NULL, numbers as-is, Buffer as X'..', the rest quoted. */
export function literal(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
	const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
	return "'" + s.replace(/[\\'\0\n\r]/g, c => '\\' + ({ '\0': '0', '\n': 'n', '\r': 'r' }[c] ?? c)) + "'";
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
