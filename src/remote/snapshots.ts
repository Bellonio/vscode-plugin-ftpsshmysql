import * as vscode from 'vscode';
import { createHash } from 'node:crypto';

interface Snapshot { mtime: number; size: number; content: string /* base64 */ }

/**
 * Last known content of the remote files open in editors, so that after a VSCode restart the tabs come back
 * WITHOUT connecting or asking the master password. Plain local copies in the extension's global storage,
 * removed when their tab is closed.
 */
export class Snapshots {
	constructor(private dir: vscode.Uri) {}

	private file(uri: vscode.Uri) {
		return vscode.Uri.joinPath(this.dir, createHash('sha256').update(uri.toString()).digest('hex') + '.json');
	}

	async get(uri: vscode.Uri): Promise<{ mtime: number; size: number; content: Uint8Array } | undefined> {
		try {
			const s: Snapshot = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.file(uri))).toString('utf8'));
			return { mtime: s.mtime, size: s.size, content: Buffer.from(s.content, 'base64') };
		} catch {
			return undefined;
		}
	}

	async set(uri: vscode.Uri, mtime: number, content: Uint8Array): Promise<void> {
		const s: Snapshot = { mtime, size: content.byteLength, content: Buffer.from(content).toString('base64') };
		try {
			await vscode.workspace.fs.createDirectory(this.dir);
			await vscode.workspace.fs.writeFile(this.file(uri), Buffer.from(JSON.stringify(s)));
		} catch {
			// best effort: without a snapshot the tab simply can't be restored offline
		}
	}

	/** Removes snapshots of files no longer open in any tab. */
	async prune(openUris: vscode.Uri[]): Promise<void> {
		const keep = new Set(openUris.map(u => this.file(u).path));
		let entries: [string, vscode.FileType][] = [];
		try { entries = await vscode.workspace.fs.readDirectory(this.dir); } catch { return; }
		for (const [name] of entries) {
			const f = vscode.Uri.joinPath(this.dir, name);
			if (!keep.has(f.path)) await vscode.workspace.fs.delete(f).then(undefined, () => undefined);
		}
	}
}
