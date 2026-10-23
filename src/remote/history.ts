import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const HISTORY_MAX_SIZE = 1024 * 1024;
export const HISTORY_MAX_VERSIONS = 50;

/**
 * Past versions of remote files, one copy each time a file is read from the server: a last resort to recover
 * an old version after a bad overwrite. Plain local files, one folder per remote file (with `uri.txt` naming it),
 * versions named `<ISO timestamp>-<basename>` so they sort by date and keep their extension.
 */
export class History {
	// ponytail: one global queue, so concurrent reads of the same file can't both pass the duplicate check
	private queue: Promise<void> = Promise.resolve();
	private lastTime = 0;

	constructor(private dir: string) {}

	private folder(uri: string) {
		return join(this.dir, createHash('sha256').update(uri).digest('hex'));
	}

	private async versions(folder: string): Promise<string[]> {
		try {
			return (await fs.readdir(folder)).filter(n => n !== 'uri.txt').sort();
		} catch {
			return [];
		}
	}

	/** Skips files of 1 MB or more and content identical to the latest version; keeps the newest 50. */
	add(uri: string, content: Uint8Array): Promise<void> {
		if (content.byteLength >= HISTORY_MAX_SIZE) return Promise.resolve();
		return this.queue = this.queue.then(() => this.write(uri, content));
	}

	private async write(uri: string, content: Uint8Array): Promise<void> {
		const folder = this.folder(uri);
		try {
			const names = await this.versions(folder);
			const last = names[names.length - 1];
			if (last && Buffer.from(content).equals(await fs.readFile(join(folder, last)))) return;
			await fs.mkdir(folder, { recursive: true });
			await fs.writeFile(join(folder, 'uri.txt'), uri);
			const base = (uri.split('/').pop() || 'file').replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
			// Strictly increasing within a session: two versions in the same millisecond must not share a name.
			this.lastTime = Math.max(Date.now(), this.lastTime + 1);
			const name = `${new Date(this.lastTime).toISOString().replace(/[:.]/g, '-')}-${base}`;
			await fs.writeFile(join(folder, name), content);
			names.push(name);
			for (const old of names.slice(0, -HISTORY_MAX_VERSIONS)) await fs.rm(join(folder, old), { force: true });
		} catch {
			// best effort: a missing version must never break opening the file
		}
	}

	/** Path of the latest saved version, if any. */
	async latest(uri: string): Promise<string | undefined> {
		const folder = this.folder(uri);
		const last = (await this.versions(folder)).pop();
		return last && join(folder, last);
	}
}
