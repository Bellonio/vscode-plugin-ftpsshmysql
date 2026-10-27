import * as vscode from 'vscode';
import type { Client } from 'ssh2';
import type { Connection } from 'mysql2/promise';
import { connectMysql } from './mysql/mysql';
import { FtpFs } from './remote/ftpClient';
import { Entry, RemoteFs, sortEntries } from './remote/remoteFs';
import { connectSsh, openSftp, SftpFs, SshParams } from './remote/sshClient';
import { mysqlKey, Secrets, Space } from './spaces';
import { Store } from './store';
import { Vault } from './vault';

const HOST_KEYS = 'wsm.hostKeys';
// ponytail: fixed 8h; becomes a setting when the settings panel exists.
const IDLE_MS = 8 * 60 * 60 * 1000;

/**
 * An unlocked space: decrypted secrets live only here, in memory, until disconnect.
 * Connections are lazy and shared (terminal, telemetry and MySQL tunnel reuse the same SSH client).
 * A dropped connection is re-opened with the in-memory secrets, without asking the master password again.
 */
export class Session {
	/**
	 * Directory listings already loaded. The tree reads from here, so a refresh of the view (pin, reorder, reconnect
	 * icon) does not re-list every expanded folder on the server; the search also uses it and never contacts the server.
	 */
	readonly cache = new Map<string, Entry[]>();
	private loading = new Map<string, Promise<Entry[]>>();
	private ssh?: Promise<Client>;
	private fs?: Promise<RemoteFs>;
	/** MySQL connections by connection id. */
	private db = new Map<string, Promise<Connection>>();

	constructor(public space: Space, private secrets: Secrets, private state: vscode.Memento) {}

	get isSftp() {
		return this.space.files?.protocol === 'sftp';
	}

	getSsh(): Promise<Client> {
		const f = this.space.files;
		if (!f || f.protocol !== 'sftp') return Promise.reject(new Error('Questo spazio non ha un accesso SSH.'));
		if (!this.ssh) {
			const params: SshParams = { host: f.host, port: f.port, user: f.user };
			if (f.auth === 'key') {
				params.privateKey = this.secrets.privateKey;
				params.passphrase = this.secrets.passphrase || undefined;
			} else params.password = this.secrets.filesPassword;
			const p = (this.ssh = this.checkCredentials()
				.then(() => connectSsh(params, fp => this.checkHost(`${f.host}:${f.port}`, fp)))
				.then(client => {
					client.on('close', () => {
						if (this.ssh === p) this.ssh = this.fs = undefined;
						for (const m of this.space.mysql ?? []) if (m.viaSsh) this.db.delete(m.id);
					});
					return client;
				}));
			p.catch(() => { if (this.ssh === p) this.ssh = undefined; });
		}
		return this.ssh;
	}

	getFs(): Promise<RemoteFs> {
		const f = this.space.files;
		if (!f) return Promise.reject(new Error('Questo spazio non ha un accesso ai file.'));
		if (!this.fs) {
			const p = (this.fs = f.protocol === 'sftp'
				? this.getSsh().then(async c => {
					const sftp = await openSftp(c);
					// The SFTP channel can close on its own (server side) while SSH stays up: reopen it next time.
					sftp.on('close', () => { if (this.fs === p) this.fs = undefined; });
					return new SftpFs(c, sftp);
				})
				: this.checkCredentials().then(() => FtpFs.connect({
					host: f.host, port: f.port, user: f.user, password: this.secrets.filesPassword,
					secure: !!f.ftps,
					secureOptions: f.ftps && f.ftpsInsecure ? { rejectUnauthorized: false } : undefined,
				})));
			p.catch(() => { if (this.fs === p) this.fs = undefined; });
		}
		return this.fs;
	}

	/** Cached listing (sorted, hidden files filtered); concurrent requests for the same folder share one server call. */
	list(dir: string): Promise<Entry[]> {
		const cached = this.cache.get(dir);
		if (cached) return Promise.resolve(cached);
		let p = this.loading.get(dir);
		if (!p) {
			p = this.getFs()
				.then(fs => fs.list(dir))
				.then(list => {
					const shown = sortEntries(list).filter(e => this.space.files?.showHidden || !e.name.startsWith('.'));
					if (this.loading.get(dir) === p) this.cache.set(dir, shown); // skip if invalidated meanwhile
					return shown;
				})
				.finally(() => { if (this.loading.get(dir) === p) this.loading.delete(dir); });
			this.loading.set(dir, p);
		}
		return p;
	}

	/** Forgets the listing of `dir` and of everything below it. */
	invalidate(dir: string) {
		const prefix = dir === '/' ? '/' : dir + '/';
		for (const map of [this.cache, this.loading]) {
			for (const k of [...map.keys()]) if (k === dir || k.startsWith(prefix)) map.delete(k);
		}
	}

	/** MySQL connection `connId`, or the first one of the space when omitted. */
	getMysql(connId?: string): Promise<Connection> {
		const m = connId ? this.space.mysql?.find(c => c.id === connId) : this.space.mysql?.[0];
		if (!m) return Promise.reject(new Error('Connessione MySQL non trovata in questo spazio.'));
		let p = this.db.get(m.id);
		if (!p) {
			const forget = () => { if (this.db.get(m.id) === p) this.db.delete(m.id); };
			p = (m.viaSsh ? this.getSsh() : Promise.resolve(undefined))
				.then(ssh => connectMysql(m, this.secrets[mysqlKey(m.id)] ?? '', ssh))
				.then(conn => {
					conn.on('error', forget);
					conn.on('end', forget);
					return conn;
				});
			this.db.set(m.id, p);
			p.catch(forget);
		}
		return p;
	}

	/** Refuse to contact the server with credentials we know are missing: a doomed login only risks a ban. */
	private async checkCredentials() {
		const f = this.space.files!;
		const missing = f.protocol === 'sftp' && f.auth === 'key' ? !this.secrets.privateKey : !this.secrets.filesPassword;
		if (missing) throw new Error(`Credenziali mancanti per "${this.space.name}": modifica lo spazio e reinseriscile.`);
	}

	/** Trust-on-first-use host key check. */
	private async checkHost(id: string, fp: string): Promise<boolean> {
		const known = this.state.get<Record<string, string>>(HOST_KEYS, {});
		if (known[id] === fp) return true;
		const msg = known[id]
			? `ATTENZIONE: la chiave del server ${id} è CAMBIATA.\nPrima: ${known[id]}\nOra: ${fp}\nPotrebbe essere una reinstallazione del server o un attacco man-in-the-middle.`
			: `Prima connessione a ${id}.\nFingerprint della chiave: ${fp}\nFidarsi di questo server?`;
		const ok = await vscode.window.showWarningMessage(msg, { modal: true }, known[id] ? 'Connetti e aggiorna la chiave' : 'Fidati e connetti');
		if (!ok) return false;
		await this.state.update(HOST_KEYS, { ...known, [id]: fp });
		return true;
	}

	dispose() {
		const swallow = () => undefined;
		this.fs?.then(fs => fs.close(), swallow);
		for (const p of this.db.values()) p.then(c => c.destroy(), swallow);
		this.ssh?.then(c => c.end(), swallow);
		this.fs = this.ssh = undefined;
		this.db.clear();
		this.cache.clear();
		this.loading.clear();
		this.secrets = {};
	}
}

export class Sessions implements vscode.Disposable {
	private map = new Map<string, Session>();
	private pending = new Map<string, Promise<Session | undefined>>();
	private changed = new vscode.EventEmitter<string>();
	/** Fires with the space id when it gets connected or disconnected. */
	readonly onDidChange = this.changed.event;
	private lastActivity = Date.now();
	/** Wall clock check, so it also fires right after the PC wakes from sleep. */
	private idleTimer = setInterval(() => {
		if (!this.map.size || Date.now() - this.lastActivity < IDLE_MS) return;
		this.closeAll();
		vscode.window.showInformationMessage('WebSpace Manager: connessioni chiuse dopo 8 ore di inattività.');
	}, 5 * 60 * 1000);

	constructor(private store: Store, private vault: Vault, private state: vscode.Memento) {
		// Keep live sessions in sync with cosmetic changes (pin, order, name); drop sessions of deleted spaces and of spaces
		// whose connection config or credentials changed (e.g. import "overwrite"): old secrets must never reach a new host.
		store.onDidChange(() => {
			for (const [id, s] of this.map) {
				const space = store.get(id);
				if (!space || space.secrets !== s.space.secrets ||
					JSON.stringify([space.files, space.mysql]) !== JSON.stringify([s.space.files, s.space.mysql])) this.close(id);
				else s.space = space;
			}
		});
	}

	/** Records user activity in VS Code (see the idle disconnect). */
	touch() {
		this.lastActivity = Date.now();
	}

	get(spaceId: string): Session | undefined {
		return this.map.get(spaceId);
	}

	all(): Session[] {
		return [...this.map.values()];
	}

	/** Returns the live session, or unlocks the space asking the master password. */
	open(spaceId: string): Promise<Session | undefined> {
		this.touch();
		const live = this.map.get(spaceId);
		if (live) return Promise.resolve(live);
		let p = this.pending.get(spaceId);
		if (!p) {
			p = (async () => {
				const space = this.store.get(spaceId);
				if (!space) return;
				const secrets = await this.vault.unlockSecrets(space);
				if (!secrets) return;
				const s = new Session(space, secrets, this.state);
				this.map.set(spaceId, s);
				this.changed.fire(spaceId);
				return s;
			})().finally(() => this.pending.delete(spaceId));
			this.pending.set(spaceId, p);
		}
		return p;
	}

	close(spaceId: string) {
		const s = this.map.get(spaceId);
		if (!s) return;
		s.dispose();
		this.map.delete(spaceId);
		this.changed.fire(spaceId);
	}

	closeAll() {
		for (const id of [...this.map.keys()]) this.close(id);
	}

	dispose() {
		clearInterval(this.idleTimer);
		this.closeAll();
	}
}
