import type { Client } from 'ssh2';
import { Connection, createConnection, FieldPacket } from 'mysql2/promise';
import { MysqlConfig } from '../spaces';
import { RowSource } from './sqlgen';

/** Direct connection, or through an SSH channel (forwardOut) without opening any local port. */
export async function connectMysql(cfg: MysqlConfig, password: string, ssh?: Client): Promise<Connection> {
	const stream = ssh && await new Promise<any>((resolve, reject) =>
		ssh.forwardOut('127.0.0.1', 0, cfg.host, cfg.port, (err, ch) => (err ? reject(err) : resolve(ch))));
	return createConnection({
		host: cfg.host,
		port: cfg.port,
		user: cfg.user,
		password,
		database: cfg.database || undefined,
		stream,
		connectTimeout: 15000,
		multipleStatements: true,
		dateStrings: true,
		supportBigNumbers: true,
		bigNumberStrings: true,
	});
}

export interface ResultSet {
	columns: string[];
	rows: unknown[][];
	/** For statements without a result set (INSERT/UPDATE/...). */
	info?: string;
	/** Set when every column is a plain column of one table: rows can then be edited/duplicated/deleted. */
	source?: RowSource;
}

/** Runs one or more statements and normalizes the mysql2 output into a list of result sets. */
export async function runSql(conn: Connection, sql: string, database?: string): Promise<ResultSet[]> {
	if (database) await conn.query(`USE ${conn.escapeId(database)}`);
	const [res, fields] = await conn.query({ sql, rowsAsArray: true });
	// Multiple statements: res is an array of per-statement results and fields an array of field lists.
	const multi = Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined);
	const parts: [unknown, FieldPacket[] | undefined][] = multi
		? (res as unknown[]).map((r, i) => [r, (fields as unknown as (FieldPacket[] | undefined)[])[i]])
		: [[res, fields]];
	return parts.map(([r, f]) => f && Array.isArray(r)
		? { columns: f.map(c => c.name), rows: r as unknown[][], source: rowSource(f) }
		: { columns: [], rows: [], info: describeHeader(r) });
}

function rowSource(f: FieldPacket[]): RowSource | undefined {
	const db = f[0]?.db ?? f[0]?.schema, table = f[0]?.orgTable;
	if (!db || !table || f.some(c => !c.orgName || c.orgTable !== table || (c.db ?? c.schema) !== db)) return undefined;
	const columns = f.map(c => c.orgName);
	return new Set(columns).size === columns.length ? { db, table, columns } : undefined;
}

function describeHeader(r: any): string {
	if (!r || typeof r !== 'object') return 'OK';
	const parts = [`Righe interessate: ${r.affectedRows ?? 0}`];
	if (r.insertId) parts.push(`insertId: ${r.insertId}`);
	if (r.info) parts.push(r.info);
	return parts.join(' · ');
}
