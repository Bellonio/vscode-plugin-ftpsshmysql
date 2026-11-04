import * as vscode from 'vscode';
import { Sessions } from '../session';
import { Entry, normalize, NotFoundError, RemoteFs, within } from './remoteFs';
import { History } from './history';
import { Snapshots } from './snapshots';

/**
 * Remote files as wsm://<spaceId>/<absolute path>: opening reads, saving uploads directly (SFTP and FTP alike),
 * no temp files. Every path is checked to stay inside the space's root path.
 *
 * Reads never connect on their own: when there is no live connection (tabs restored after a VSCode restart, connection
 * dropped or refused) they are served from the local snapshot. Only writes (Ctrl+S, create, delete, rename) open the connection and
 * ask the master password; before overwriting, the remote file is compared with the snapshot to catch changes
 * made on the server in the meantime.
 */
export class WsmFileSystem implements vscode.FileSystemProvider {
	private changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changed.event;
	/** Documents being re-read on purpose: stat reports the real remote file. */
	private reloading = new Set<string>();
	/** Last remote version (mtime:size) the user was asked to reload, per document. */
	private asked = new Map<string, string>();

	constructor(private sessions: Sessions, private snapshots: Snapshots, private history: History) {}

	/** `connect`: open the session (asking the password) if needed; otherwise undefined when not connected. */
	private async resolve(uri: vscode.Uri, connect: boolean): Promise<{ fs: RemoteFs; path: string } | undefined> {
		const s = connect ? await this.sessions.open(uri.authority) : this.sessions.get(uri.authority);
		if (!s) {
			if (connect) throw vscode.FileSystemError.NoPermissions('Superpassword non inserita: file non salvato');
			return;
		}
		const path = normalize(uri.path);
		const root = s.space.files?.rootPath || '/';
		if (!within(root, path)) throw vscode.FileSystemError.NoPermissions(`Fuori dalla root path ${root}`);
		const fs = connect ? await s.getFs() : await s.liveFs();
		return fs && { fs, path };
	}

	private notConnected(uri: vscode.Uri): never {
		throw vscode.FileSystemError.Unavailable(`Spazio non connesso: apri il file dall'albero WebSpace per connetterti (${uri.path})`);
	}

	private async wrap<T>(uri: vscode.Uri, connect: boolean, fn: (fs: RemoteFs, path: string) => Promise<T>, offline?: () => Promise<T>): Promise<T> {
		const r = await this.resolve(uri, connect);
		if (!r) return offline ? offline() : this.notConnected(uri);
		try {
			return await fn(r.fs, r.path);
		} catch (e) {
			if (e instanceof NotFoundError) throw vscode.FileSystemError.FileNotFound(uri);
			throw e;
		}
	}

	private async offlineSnapshot(uri: vscode.Uri) {
		return (await this.snapshots.get(uri)) ?? this.notConnected(uri);
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	/**
	 * VSCode re-stats an open document when its tab is shown again and silently reloads it when mtime/size changed.
	 * For a document already open we keep reporting the snapshot (what the editor shows) and ask before reloading.
	 */
	stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		return this.wrap<vscode.FileStat>(uri, false, async (fs, path) => {
			const st = await fs.stat(path);
			const key = uri.toString();
			const open = st.type === 'file' && !this.reloading.has(key) && vscode.workspace.textDocuments.some(d => d.uri.toString() === key);
			const snap = open ? await this.snapshots.get(uri) : undefined;
			if (!snap || (snap.mtime === st.mtime && snap.size === st.size)) return toStat(st);
			void this.askReload(uri, `${st.mtime}:${st.size}`);
			return { type: vscode.FileType.File, size: snap.size, mtime: snap.mtime, ctime: snap.mtime };
		}, async () => {
			const s = await this.offlineSnapshot(uri);
			return { type: vscode.FileType.File, size: s.size, mtime: s.mtime, ctime: s.mtime };
		});
	}

	/**
	 * Asked once per remote version: dismissing it leaves the editor as is until the server file changes again.
	 * Dirty documents are skipped: VSCode never reloads them and only stats them to save, where confirmOverwrite asks.
	 */
	private async askReload(uri: vscode.Uri, version: string) {
		const key = uri.toString();
		const name = uri.path.split('/').pop();
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
		if (!doc || doc.isDirty || this.asked.get(key) === version) return;
		this.asked.set(key, version);
		const ok = await vscode.window.showWarningMessage(
			`${name} è stato modificato sul server. Ricaricarlo? Il contenuto attuale dell'editor verrà sostituito.`, 'Ricarica');
		if (!ok) return;
		// The notification may be clicked much later, after new edits.
		if (doc.isDirty && !await vscode.window.showWarningMessage(
			`${name} ha modifiche non salvate che andranno perse. Ricaricarlo comunque?`, { modal: true }, 'Ricarica')) return;
		await this.reload(uri).catch(e => vscode.window.showErrorMessage(`${name}: ${e?.message ?? e}`));
	}

	/** Re-reads an open document from the server (no confirmation: callers ask first). */
	async reload(uri: vscode.Uri) {
		const key = uri.toString();
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
		if (!doc) return;
		// Explicit action: connect now, or the editor reads would silently get the old snapshot back.
		await this.resolve(uri, true);
		const tab = vscode.window.tabGroups.all.flatMap(g => g.tabs)
			.find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
		this.reloading.add(key);
		try {
			// Focus the existing tab (in its own group): the revert command acts on the active editor.
			await vscode.window.showTextDocument(doc, { viewColumn: tab?.group.viewColumn, preview: tab?.isPreview });
			await vscode.commands.executeCommand('workbench.action.files.revert');
		} finally {
			this.reloading.delete(key);
		}
	}

	readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		return this.wrap(uri, false, async (fs, path) =>
			(await fs.list(path)).map(e => [e.name, e.type === 'dir' ? vscode.FileType.Directory : vscode.FileType.File] as [string, vscode.FileType]));
	}

	readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return this.wrap(uri, false, async (fs, path) => {
			const [content, st] = await Promise.all([fs.readFile(path), fs.stat(path)]);
			await this.snapshots.set(uri, st.mtime, content);
			await this.history.add(uri.toString(), content);
			return content;
		}, async () => (await this.offlineSnapshot(uri)).content);
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
		return this.wrap(uri, true, async (fs, path) => {
			const name = path.split('/').pop();
			// Status bar spinner while uploading; failures already surface through VSCode's save error.
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Salvataggio ${name}...` }, async () => {
				let remote: Entry | undefined;
				try { remote = await fs.stat(path); } catch (e) { if (!(e instanceof NotFoundError)) throw e; }
				if (!remote && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
				if (remote && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
				if (remote) await this.confirmOverwrite(uri, remote);
				await fs.writeFile(path, content);
				const st = await fs.stat(path).catch(() => undefined);
				await this.snapshots.set(uri, st?.mtime ?? Date.now(), content);
				this.changed.fire([{ type: remote ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
			});
			vscode.window.setStatusBarMessage(`$(check) Salvato ${name}`, 3000);
		});
	}

	/** The file changed on the server since we last read/wrote it (snapshot): don't overwrite silently. */
	private async confirmOverwrite(uri: vscode.Uri, remote: Entry) {
		const snap = await this.snapshots.get(uri);
		if (!snap || (snap.mtime === remote.mtime && snap.size === remote.size)) return;
		const ok = await vscode.window.showWarningMessage(
			`${uri.path}\nè stato modificato sul server dopo l'ultima volta che l'hai aperto o salvato. Sovrascriverlo con la tua versione?`,
			{ modal: true }, 'Sovrascrivi');
		if (!ok) throw vscode.FileSystemError.NoPermissions('Salvataggio annullato: il file sul server è più recente');
	}

	createDirectory(uri: vscode.Uri): Promise<void> {
		return this.wrap(uri, true, (fs, path) => fs.mkdir(path));
	}

	delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
		return this.wrap(uri, true, (fs, path) => fs.delete(path, options.recursive));
	}

	rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
		if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.NoPermissions('Spostamento tra spazi diversi non supportato');
		return this.wrap(oldUri, true, async (fs, from) => {
			const to = (await this.resolve(newUri, true))!.path;
			await fs.rename(from, to);
		});
	}
}

const toStat = (e: Entry): vscode.FileStat =>
	({ type: e.type === 'dir' ? vscode.FileType.Directory : vscode.FileType.File, size: e.size, mtime: e.mtime, ctime: e.mtime });
