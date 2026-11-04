import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Client, ClientChannel, SFTPWrapper, Stats } from 'ssh2';
import { AuthError, Entry, NotFoundError, RemoteFs } from './remoteFs';

export interface SshParams {
	host: string;
	port: number;
	user: string;
	password?: string;
	privateKey?: string;
	passphrase?: string;
}

/** Asked on every connect with the SHA256 fingerprint; return false to abort. */
export type HostCheck = (fingerprint: string) => Promise<boolean>;

/**
 * The password goes to the server once per login: through `password` if offered, otherwise `keyboard-interactive`.
 * ssh2's default handler would try both, and each one counts as a failed attempt for fail2ban.
 */
function passwordAuth() {
	let step = 0;
	return (methodsLeft: string[] | null): 'none' | 'password' | 'keyboard-interactive' | false => {
		step++;
		if (step === 1) return 'none'; // the failure reply lists the methods the server accepts
		if (step > 2) return false;
		if (methodsLeft?.includes('password')) return 'password';
		return methodsLeft?.includes('keyboard-interactive') ? 'keyboard-interactive' : false;
	};
}

export function connectSsh(p: SshParams, checkHost: HostCheck, timeoutMs = 15000): Promise<Client> {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let settled = false;
		// Our own timer instead of ssh2's readyTimeout, which also runs while the user reads the host key prompt.
		let timer: NodeJS.Timeout | undefined;
		const startTimer = () => {
			timer = setTimeout(() => {
				settled = true;
				client.destroy();
				reject(new Error(`Il server SSH non ha risposto entro ${timeoutMs / 1000} secondi.`));
			}, timeoutMs);
		};
		client
			.on('ready', () => { clearTimeout(timer); settled = true; resolve(client); })
			.on('error', (err: Error & { level?: string }) => {
				clearTimeout(timer);
				if (settled) return; // later errors surface through 'close' and the failing operation
				settled = true;
				client.end();
				reject(err.level === 'client-authentication'
					// ponytail: no automatic retry on auth failure, to avoid fail2ban bans.
					? new AuthError('Autenticazione SSH fallita: controlla utente/password/chiave. Nessun nuovo tentativo automatico: disconnetti lo spazio per riprovare.')
					: err);
			})
			// ssh2 emits no error when the server hangs up after its banner (typical of a ban): don't wait forever.
			.on('close', () => { clearTimeout(timer); settled = true; reject(new Error('Il server SSH ha chiuso la connessione prima del login.')); })
			.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => p.password ?? '')))
			.connect({
				host: p.host,
				port: p.port,
				username: p.user,
				password: p.password,
				privateKey: p.privateKey,
				passphrase: p.passphrase,
				tryKeyboard: !!p.password, // only allows the method: passwordAuth() decides whether it gets used
				authHandler: p.password ? passwordAuth() as any : undefined,
				readyTimeout: 0,
				keepaliveInterval: 30000,
				keepaliveCountMax: 3,
				hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
					const fp = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
					// ssh2 calls this again at every rekey of an established connection: the timer must not restart then.
					clearTimeout(timer);
					checkHost(fp).then(ok => { if (ok && !settled) startTimer(); verify(ok); }, () => verify(false));
				},
			});
		startTimer();
	});
}

export function openSftp(client: Client): Promise<SFTPWrapper> {
	return new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
}

export function openShell(client: Client, cols: number, rows: number): Promise<ClientChannel> {
	return new Promise((resolve, reject) =>
		client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => (err ? reject(err) : resolve(stream))));
}

export interface ExecResult { stdout: string; stderr: string; code: number | null }

export function exec(client: Client, command: string): Promise<ExecResult> {
	return new Promise((resolve, reject) =>
		client.exec(command, (err, stream) => {
			if (err) return reject(err);
			let stdout = '', stderr = '';
			stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
			stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
			stream.on('close', (code: number | null) => resolve({ stdout, stderr, code }));
		}));
}

/** Single-quote for POSIX shells. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const NO_SUCH_FILE = 2;

export class SftpFs implements RemoteFs {
	constructor(private client: Client, private sftp: SFTPWrapper) {}

	private call<T>(fn: (cb: (err: any, res?: T) => void) => void, path: string): Promise<T> {
		return new Promise((resolve, reject) =>
			fn((err, res) => (err ? reject(err.code === NO_SUCH_FILE ? new NotFoundError(path) : err) : resolve(res as T))));
	}

	private toEntry(path: string, st: Stats, link = false): Entry {
		return { name: posix.basename(path) || '/', path, type: st.isDirectory() ? 'dir' : 'file', link, size: st.size, mtime: st.mtime * 1000 };
	}

	async list(dir: string): Promise<Entry[]> {
		const items = await this.call<any[]>(cb => this.sftp.readdir(dir, cb), dir);
		return Promise.all(items
			.filter(i => i.filename !== '.' && i.filename !== '..')
			.map(async i => {
				const path = posix.join(dir, i.filename);
				if (!i.attrs.isSymbolicLink()) return this.toEntry(path, i.attrs);
				// Resolve the link target type; broken links show up as files.
				try { return this.toEntry(path, await this.call<Stats>(cb => this.sftp.stat(path, cb), path), true); }
				catch { return this.toEntry(path, i.attrs, true); }
			}));
	}

	async stat(path: string): Promise<Entry> {
		return this.toEntry(path, await this.call<Stats>(cb => this.sftp.stat(path, cb), path));
	}

	readFile(path: string): Promise<Buffer> {
		return this.call<Buffer>(cb => this.sftp.readFile(path, cb), path);
	}

	writeFile(path: string, data: Uint8Array): Promise<void> {
		return this.call<void>(cb => this.sftp.writeFile(path, Buffer.from(data), cb), path);
	}

	mkdir(path: string): Promise<void> {
		return this.call<void>(cb => this.sftp.mkdir(path, cb), path);
	}

	rename(from: string, to: string): Promise<void> {
		return this.call<void>(cb => this.sftp.rename(from, to, cb), from);
	}

	async delete(path: string, recursive: boolean): Promise<void> {
		const st = await this.call<Stats>(cb => this.sftp.lstat(path, cb), path);
		if (!st.isDirectory()) return this.call<void>(cb => this.sftp.unlink(path, cb), path);
		if (recursive) {
			// ponytail: sequential walk over SFTP; works on SFTP-only accounts where `rm -rf` via exec is not allowed.
			for (const child of await this.call<any[]>(cb => this.sftp.readdir(path, cb), path)) {
				if (child.filename === '.' || child.filename === '..') continue;
				await this.delete(posix.join(path, child.filename), true);
			}
		}
		return this.call<void>(cb => this.sftp.rmdir(path, cb), path);
	}

	upload(localPath: string, remotePath: string): Promise<void> {
		return this.call<void>(cb => this.sftp.fastPut(localPath, remotePath, cb), remotePath);
	}

	download(remotePath: string, localPath: string): Promise<void> {
		return this.call<void>(cb => this.sftp.fastGet(remotePath, localPath, cb), remotePath);
	}

	close(): void {
		this.sftp.end();
		this.client.end();
	}

	/** Session forgets this object as soon as the SSH connection or the SFTP channel closes. */
	connected(): boolean {
		return true;
	}
}
