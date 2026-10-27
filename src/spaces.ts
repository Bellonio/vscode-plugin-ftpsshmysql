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
	/** Stable id: the password is stored in the secrets blob under `mysqlKey(id)`. */
	id: string;
	/** Optional label shown in the tree. */
	name?: string;
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
	/** Sidebar folder name (none = root). */
	group?: string;
	files?: FilesConfig;
	mysql?: MysqlConfig[];
	/** Encrypted Secrets blob ('' = no secrets stored). */
	secrets: string;
	/** Export files for a colleague only: secrets removed from the blob, by group id (see stripSecrets). Never stored. */
	missing?: Missing;
}

/** Secret key (see `Secrets`) -> group id. */
export type Missing = Partial<Record<keyof Secrets, string>>;

export interface Secrets {
	filesPassword?: string;
	privateKey?: string;
	passphrase?: string;
	/** Legacy single-connection password: moved to `mysqlKey(LEGACY_MYSQL_ID)` by `migrateSecrets`. */
	mysqlPassword?: string;
	/** One password per MySQL connection. */
	[k: `mysqlPassword:${string}`]: string | undefined;
}

export type SecretField = 'filesPassword' | 'privateKey' | 'passphrase' | 'mysqlPassword';
export const SECRET_FIELDS: SecretField[] = ['filesPassword', 'privateKey', 'passphrase', 'mysqlPassword'];

/** Field of a secret key: `mysqlPassword:<id>` -> `mysqlPassword`. */
export const baseField = (k: string) => k.split(':')[0] as SecretField;
export const mysqlKey = (connId: string) => `mysqlPassword:${connId}` as const;

/** Id given to the single MySQL connection of spaces saved before multiple connections existed. */
export const LEGACY_MYSQL_ID = 'm';

/** Upgrades a stored/imported space: the old single `mysql` object becomes a one-element list. */
export function normalizeSpace(s: Space): Space {
	const m = s.mysql as unknown;
	if (m && !Array.isArray(m)) return { ...s, mysql: [{ ...(m as Omit<MysqlConfig, 'id'>), id: LEGACY_MYSQL_ID }] };
	if (Array.isArray(m) && !m.length) return { ...s, mysql: undefined };
	return s;
}

/** Decrypted blob of an old space: its MySQL password belongs to the legacy connection. */
export function migrateSecrets(s: Secrets): Secrets {
	if (!s.mysqlPassword) return s;
	const { mysqlPassword, ...rest } = s;
	return { [mysqlKey(LEGACY_MYSQL_ID)]: mysqlPassword, ...rest };
}

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

/**
 * Moves a space among its siblings (same folder, same pinned state) and renumbers `order` 0..n-1. Returns a new array.
 * Spaces of other folders keep their relative order, since `order` is only compared inside a folder.
 */
export function moveSpace(spaces: Space[], id: string, dir: MoveDir): Space[] {
	const list = sortSpaces(spaces, 'manual').map(s => ({ ...s }));
	const target = list.find(s => s.id === id);
	if (!target) return list;
	const same = (s: Space) => s.pinned === target.pinned && (s.group ?? '') === (target.group ?? '');
	const slots = list.flatMap((s, i) => (same(s) ? [i] : []));
	const from = slots.indexOf(list.indexOf(target));
	const to = Math.min(slots.length - 1, Math.max(0,
		dir === 'up' ? from - 1 : dir === 'down' ? from + 1 : dir === 'top' ? 0 : slots.length - 1));
	const siblings = slots.map(i => list[i]);
	siblings.splice(to, 0, ...siblings.splice(from, 1));
	slots.forEach((i, k) => (list[i] = siblings[k]));
	list.forEach((s, i) => (s.order = i));
	return list;
}

/** Folder names in use, alphabetical. */
export function groupNames(spaces: Space[]): string[] {
	return [...new Set(spaces.map(s => s.group).filter((g): g is string => !!g))].sort(cmp);
}

/**
 * Filter keys of a space: `host:<host>` for files and MySQL hosts, `type:sftp|ftp|mysql`.
 * A MySQL host reached through the SSH tunnel is relative to the server (usually localhost), so it is not a server.
 */
export function filterKeys(s: Space): string[] {
	const keys = [
		s.files && `host:${s.files.host}`, ...(s.mysql ?? []).map(m => !m.viaSsh && `host:${m.host}`),
		s.files && `type:${s.files.protocol}`, s.mysql?.length && 'type:mysql',
	].filter((k): k is string => !!k);
	return [...new Set(keys)];
}

/** OR inside a group (host / type), AND across groups. Empty selection = all. */
export function applyFilter(spaces: Space[], selected: string[]): Space[] {
	const groups = ['host:', 'type:'].map(g => selected.filter(k => k.startsWith(g))).filter(g => g.length);
	return spaces.filter(s => {
		const keys = filterKeys(s);
		return groups.every(g => g.some(k => keys.includes(k)));
	});
}

export function nextOrder(spaces: Space[]): number {
	return spaces.reduce((m, s) => Math.max(m, s.order + 1), 0);
}

/**
 * Removes the chosen secrets for an export to a colleague. Equal values get the same group id, so the import asks
 * each value once. The id is random, not a hash: a hash of a password could be attacked offline.
 * The passphrase goes (and is asked) together with its key, under the key's id.
 */
export function stripSecrets(list: Secrets[], fields: SecretField[]): { kept: Secrets; missing: Missing }[] {
	const groups = new Map<string, string>();
	return list.map(s => {
		const kept = { ...s }, missing: Missing = {};
		for (const f of Object.keys(s) as (keyof Secrets)[]) {
			const v = s[f], base = baseField(f);
			if (!v || base === 'passphrase' || !fields.includes(base)) continue;
			const k = `${base}\0${v}`;
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
