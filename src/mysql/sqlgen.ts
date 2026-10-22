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
