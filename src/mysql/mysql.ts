import type { Client } from 'ssh2';
import { Connection, createConnection, FieldPacket } from 'mysql2/promise';
import { MysqlConfig } from '../spaces';

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
		? { columns: f.map(c => c.name), rows: r as unknown[][] }
		: { columns: [], rows: [], info: describeHeader(r) });
}

function describeHeader(r: any): string {
	if (!r || typeof r !== 'object') return 'OK';
	const parts = [`Righe interessate: ${r.affectedRows ?? 0}`];
	if (r.insertId) parts.push(`insertId: ${r.insertId}`);
	if (r.info) parts.push(r.info);
	return parts.join(' · ');
}
