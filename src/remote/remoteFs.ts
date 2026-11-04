// Common file API implemented by SftpFs and FtpFs. Remote paths are always POSIX.
import { posix } from 'node:path';

export interface Entry {
	name: string;
	path: string;
	type: 'file' | 'dir';
	link?: boolean;
	size: number;
	mtime: number; // ms
}

export interface RemoteFs {
	list(dir: string): Promise<Entry[]>;
	/** Throws NotFoundError if the path does not exist. */
	stat(path: string): Promise<Entry>;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	mkdir(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	delete(path: string, recursive: boolean): Promise<void>;
	upload(localPath: string, remotePath: string): Promise<void>;
	download(remotePath: string, localPath: string): Promise<void>;
	close(): void;
	/** False when the next operation would have to log in again. */
	connected(): boolean;
}

export class NotFoundError extends Error {
	constructor(path: string) {
		super(`Non trovato: ${path}`);
	}
}

/** The server refused the credentials: trying again with the same ones only risks a ban. */
export class AuthError extends Error {}

export function normalize(p: string): string {
	const n = posix.normalize('/' + p.replace(/\\/g, '/'));
	return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/** True if `p` is `root` or inside it (after normalization, so `..` can't escape). */
export function within(root: string, p: string): boolean {
	const r = normalize(root), n = normalize(p);
	return r === '/' || n === r || n.startsWith(r + '/');
}

export function sortEntries(list: Entry[]): Entry[] {
	return list.sort((a, b) =>
		(a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) ||
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Creates `dir` and missing parents. */
export async function mkdirp(fs: RemoteFs, dir: string): Promise<void> {
	try {
		if ((await fs.stat(dir)).type === 'dir') return;
	} catch (e) {
		if (!(e instanceof NotFoundError)) throw e;
	}
	const parent = posix.dirname(dir);
	if (parent !== dir) await mkdirp(fs, parent);
	await fs.mkdir(dir);
}
