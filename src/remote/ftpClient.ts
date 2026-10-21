import { posix } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { AccessOptions, Client, FileInfo, FileType } from 'basic-ftp';
import { Entry, NotFoundError, RemoteFs } from './remoteFs';

/**
 * basic-ftp allows one command at a time per connection, so every operation goes through a serial queue.
 * If the server dropped an idle connection, it reconnects once with the same credentials before the operation.
 */
export class FtpFs implements RemoteFs {
	private client = new Client(20000);
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(private options: AccessOptions) {}

	static async connect(options: AccessOptions): Promise<FtpFs> {
		const fs = new FtpFs(options);
		await fs.login();
		return fs;
	}

	private async login() {
		try {
			await this.client.access(this.options);
		} catch (e: any) {
			this.client.close();
			// ponytail: 530 = login refused; no automatic retry to avoid bans.
			if (e?.code === 530) throw new Error('Autenticazione FTP fallita: controlla utente/password. Nessun nuovo tentativo automatico.');
			throw e;
		}
	}

	private async reconnect() {
		this.client.close();
		this.client = new Client(20000);
		await this.login();
	}

	private run<T>(op: (c: Client) => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => {
			if (this.client.closed) await this.reconnect();
			try {
				return await op(this.client);
			} catch (e: any) {
				// The server dropped the (idle) connection during the operation: reconnect and retry once.
				// FTP replies (numeric code) and login failures are never retried.
				if (!this.client.closed || typeof e?.code === 'number') throw e;
				await this.reconnect();
				return op(this.client);
			}
		});
		this.queue = next.catch(() => undefined);
		return next;
	}

	private toEntry(dir: string, f: FileInfo): Entry {
		return {
			name: f.name,
			path: posix.join(dir, f.name),
			type: f.type === FileType.Directory ? 'dir' : 'file',
			link: f.type === FileType.SymbolicLink || undefined,
			size: f.size,
			mtime: f.modifiedAt?.getTime() ?? 0,
		};
	}

	async list(dir: string): Promise<Entry[]> {
		return this.run(async c => {
			const entries = (await c.list(dir)).filter(f => f.name !== '.' && f.name !== '..').map(f => this.toEntry(dir, f));
			// FTP doesn't say whether a symlink points to a folder: try to enter it (paths are absolute, cwd is irrelevant).
			for (const e of entries.filter(e => e.link)) {
				try { await c.cd(e.path); e.type = 'dir'; } catch (err: any) { if (typeof err?.code !== 'number') throw err; }
			}
			return entries;
		});
	}

	async stat(path: string): Promise<Entry> {
		if (path === '/') return { name: '/', path, type: 'dir', size: 0, mtime: 0 };
		// FTP has no portable stat: look the entry up in the parent listing.
		const parent = posix.dirname(path), name = posix.basename(path);
		let list: Entry[];
		try { list = await this.list(parent); } catch (e: any) { throw e?.code === 550 ? new NotFoundError(path) : e; }
		const found = list.find(e => e.name === name);
		if (!found) throw new NotFoundError(path);
		return found;
	}

	readFile(path: string): Promise<Buffer> {
		return this.run(async c => {
			const chunks: Buffer[] = [];
			const sink = new PassThrough().on('data', (d: Buffer) => chunks.push(d));
			await c.downloadTo(sink, path);
			return Buffer.concat(chunks);
		});
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		await this.run(c => c.uploadFrom(Readable.from([Buffer.from(data)]), path));
	}

	async mkdir(path: string): Promise<void> {
		await this.run(async c => c.send('MKD ' + (await c.protectWhitespace(path))));
	}

	async rename(from: string, to: string): Promise<void> {
		await this.run(c => c.rename(from, to));
	}

	async delete(path: string, recursive: boolean): Promise<void> {
		const st = await this.stat(path);
		await this.run(async c => {
			// A link is removed as a link (DELE): never recurse into the folder it points to.
			if (st.type === 'file' || st.link) await c.remove(path);
			else if (recursive) await c.removeDir(path);
			else await c.removeEmptyDir(path);
		});
	}

	async upload(localPath: string, remotePath: string): Promise<void> {
		await this.run(c => c.uploadFrom(localPath, remotePath));
	}

	async download(remotePath: string, localPath: string): Promise<void> {
		await this.run(c => c.downloadTo(localPath, remotePath));
	}

	close(): void {
		this.client.close();
	}
}
