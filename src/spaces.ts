// Space model and ordering. Pure module (no vscode import) so it can be unit tested.

export interface FilesConfig {
	protocol: 'sftp' | 'ftp';
	host: string;
	port: number;
	user: string;
	/** SFTP only: authenticate with password or private key. FTP always uses password. */
	auth: 'password' | 'key';
	rootPath: string;
	ftps?: boolean;
	/** FTPS: accept self-signed / mismatched certificates (own hosting, shared certificate of the provider). */
	ftpsInsecure?: boolean;
	showHidden?: boolean;
}

export interface MysqlConfig {
	host: string;
	port: number;
	user: string;
	database?: string;
	/** Tunnel through the space's SSH connection (requires files.protocol === 'sftp'). */
	viaSsh: boolean;
}

export interface Space {
	id: string;
	name: string;
	pinned: boolean;
	order: number;
	files?: FilesConfig;
	mysql?: MysqlConfig;
	/** Encrypted Secrets blob ('' = no secrets stored). */
	secrets: string;
	/** Export files for a colleague only: secrets removed from the blob, by group id (see stripSecrets). Never stored. */
	missing?: Missing;
}

export type Missing = Partial<Record<keyof Secrets, string>>;

export interface Secrets {
	filesPassword?: string;
	privateKey?: string;
	passphrase?: string;
	mysqlPassword?: string;
}

export const SECRET_FIELDS: (keyof Secrets)[] = ['filesPassword', 'privateKey', 'passphrase', 'mysqlPassword'];

export type SortMode = 'alpha' | 'manual';
export type MoveDir = 'up' | 'down' | 'top' | 'bottom';

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Pinned first, then alphabetical or by manual order. */
export function sortSpaces(spaces: Space[], mode: SortMode): Space[] {
	return [...spaces].sort((a, b) =>
		Number(b.pinned) - Number(a.pinned) ||
		(mode === 'manual' ? a.order - b.order : 0) ||
		cmp(a.name, b.name));
}

/** Moves a space within its pinned/unpinned group and renumbers `order` 0..n-1. Returns a new array. */
export function moveSpace(spaces: Space[], id: string, dir: MoveDir): Space[] {
	const list = sortSpaces(spaces, 'manual').map(s => ({ ...s }));
	const from = list.findIndex(s => s.id === id);
	if (from < 0) return list;
	const pinned = list[from].pinned;
	const groupStart = list.findIndex(s => s.pinned === pinned);
	const groupEnd = groupStart + list.filter(s => s.pinned === pinned).length - 1;
	const to = Math.min(groupEnd, Math.max(groupStart,
		dir === 'up' ? from - 1 : dir === 'down' ? from + 1 : dir === 'top' ? groupStart : groupEnd));
	const [item] = list.splice(from, 1);
	list.splice(to, 0, item);
	list.forEach((s, i) => (s.order = i));
	return list;
}

export function nextOrder(spaces: Space[]): number {
	return spaces.reduce((m, s) => Math.max(m, s.order + 1), 0);
}

/**
 * Removes the chosen secrets for an export to a colleague. Equal values get the same group id, so the import asks
 * each value once. The id is random, not a hash: a hash of a password could be attacked offline.
 * The passphrase goes (and is asked) together with its key, under the key's id.
 */
export function stripSecrets(list: Secrets[], fields: (keyof Secrets)[]): { kept: Secrets; missing: Missing }[] {
	const groups = new Map<string, string>();
	return list.map(s => {
		const kept = { ...s }, missing: Missing = {};
		for (const f of fields) {
			const v = s[f];
			if (!v || f === 'passphrase') continue;
			const k = `${f}\0${v}`;
			if (!groups.has(k)) groups.set(k, newId() + newId());
			missing[f] = groups.get(k);
			delete kept[f];
		}
		if (missing.privateKey && kept.passphrase) {
			missing.passphrase = missing.privateKey;
			delete kept.passphrase;
		}
		return { kept, missing };
	});
}

export function newId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
