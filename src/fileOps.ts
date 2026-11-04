import * as vscode from 'vscode';
import { promises as lfs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { WsmFileSystem } from './remote/fsProvider';
import { History } from './remote/history';
import { mkdirp, NotFoundError, RemoteFs } from './remote/remoteFs';
import { Session, Sessions } from './session';
import { fileUri, formatSize, Node, SpacesTree } from './tree';

type DirNode = Extract<Node, { kind: 'filesRoot' | 'entry' }>;

const MAX_OPEN = 10 * 1024 * 1024;

export class FileOps {
	constructor(private sessions: Sessions, private tree: SpacesTree, private versions: History, private wsmFs: WsmFileSystem) {}

	private async ctx(node: Node | undefined): Promise<{ s: Session; fs: RemoteFs; node: DirNode } | undefined> {
		if (!node || (node.kind !== 'filesRoot' && node.kind !== 'entry')) return;
		const s = await this.sessions.open(node.spaceId);
		if (!s) return;
		return { s, fs: await s.getFs(), node };
	}

	private dirOf(n: DirNode): string {
		return n.kind === 'entry' && n.entry.type === 'file' ? posix.dirname(n.path) : n.path;
	}

	/** Re-lists `dir` (and forgets everything cached below it) and refreshes its node. */
	private refreshDir(s: Session, dir: string) {
		s.invalidate(dir);
		this.tree.refresh(this.tree.dirNode(s.space.id, dir));
	}

	refresh(node: Node) {
		const s = this.sessions.get(node.spaceId);
		if (s && (node.kind === 'filesRoot' || node.kind === 'entry')) s.invalidate(node.path);
		this.tree.refresh(node);
	}

	async open(node: Node) {
		if (node.kind !== 'entry') return;
		if (node.entry.size > MAX_OPEN) {
			const ok = await vscode.window.showWarningMessage(`${node.entry.name} pesa ${formatSize(node.entry.size)}. Aprirlo comunque?`, { modal: true }, 'Apri');
			if (!ok) return;
		}
		// Opening from the tree is an explicit action: connect first (reads by the editor never connect on their own).
		const s = await this.sessions.open(node.spaceId);
		if (!s) return;
		await s.getFs();
		const uri = fileUri(node.spaceId, node.path);
		const key = uri.toString();
		// VSCode only focuses an already open tab: re-read it, the file may have changed on the server.
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
		const tab = vscode.window.tabGroups.all.flatMap(g => g.tabs)
			.find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
		if (!doc) {
			// A tab without a document was never loaded or failed to (offline, no snapshot): reopen it from the server.
			if (tab) await vscode.window.tabGroups.close(tab);
			return void await vscode.commands.executeCommand('vscode.open', uri);
		}
		const reload = !doc.isDirty || await vscode.window.showWarningMessage(
			`${node.entry.name} ha modifiche non salvate. Sovrascriverle con la versione del server?`, { modal: true }, 'Sovrascrivi');
		if (reload) await this.wsmFs.reload(uri);
		else await vscode.window.showTextDocument(doc, { viewColumn: tab?.group.viewColumn, preview: tab?.isPreview });
	}

	/** Opens the OS file manager on the folder of the file's saved versions. */
	async history(node: Node) {
		if (node.kind !== 'entry') return;
		const last = await this.versions.latest(fileUri(node.spaceId, node.path).toString());
		if (!last) return void vscode.window.showInformationMessage(`Nessuna versione salvata per ${node.entry.name}`);
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(last));
	}

	async newFile(node: Node) {
		const c = await this.ctx(node);
		if (!c) return;
		const dir = this.dirOf(c.node);
		const name = await askName('Nome del nuovo file', '');
		if (!name) return;
		const path = posix.join(dir, name);
		if (await exists(c.fs, path)) return void vscode.window.showErrorMessage(`Esiste già: ${path}`);
		await c.fs.writeFile(path, new Uint8Array());
		this.refreshDir(c.s, dir);
		await vscode.commands.executeCommand('vscode.open', fileUri(c.s.space.id, path));
	}

	async newFolder(node: Node) {
		const c = await this.ctx(node);
		if (!c) return;
		const dir = this.dirOf(c.node);
		const name = await askName('Nome della nuova cartella', '');
		if (!name) return;
		const path = posix.join(dir, name);
		if (await exists(c.fs, path)) return void vscode.window.showErrorMessage(`Esiste già: ${path}`);
		await c.fs.mkdir(path);
		this.refreshDir(c.s, dir);
	}

	async rename(node: Node) {
		if (node?.kind !== 'entry') return;
		const c = await this.ctx(node);
		if (!c) return;
		const name = await askName('Nuovo nome', node.entry.name);
		if (!name || name === node.entry.name) return;
		const dir = posix.dirname(node.path), to = posix.join(dir, name);
		if (await exists(c.fs, to)) return void vscode.window.showErrorMessage(`Esiste già: ${to}`);
		await c.fs.rename(node.path, to);
		this.refreshDir(c.s, dir);
	}

	async delete(node: Node) {
		if (node?.kind !== 'entry') return;
		const c = await this.ctx(node);
		if (!c) return;
		const isDir = node.entry.type === 'dir' && !node.entry.link;
		const what = node.entry.link ? 'il link' : isDir ? 'la cartella' : 'il file';
		const ok = await vscode.window.showWarningMessage(
			`Eliminare definitivamente ${what}\n${node.path}${isDir ? '\ne TUTTO il suo contenuto' : ''}\nsu "${c.s.space.name}"?`,
			{ modal: true }, 'Elimina');
		if (!ok) return;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Elimino ${node.path}...` },
			() => c.fs.delete(node.path, true));
		this.refreshDir(c.s, posix.dirname(node.path));
	}

	async copyPath(node: Node) {
		if (node?.kind === 'filesRoot' || node?.kind === 'entry') await vscode.env.clipboard.writeText(node.path);
	}

	async uploadPick(node: Node, folders: boolean) {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: true, canSelectFiles: !folders, canSelectFolders: folders,
			title: folders ? 'Cartelle da caricare' : 'File da caricare', openLabel: 'Carica',
		});
		if (picked?.length) await this.upload(node, picked.map(u => u.fsPath));
	}

	/**
	 * Uploads the file in front of the user into the node's directory: the visible editor, or one picked among
	 * the visible ones in split mode. What is on screen gets uploaded, unsaved changes and untitled buffers included.
	 */
	async uploadEditor(node: Node) {
		const groups = vscode.window.tabGroups;
		const seen = new Set<string>();
		const uris = [groups.activeTabGroup, ...groups.all.filter(g => g !== groups.activeTabGroup)]
			.map(g => g.activeTab?.input)
			.flatMap(i => i instanceof vscode.TabInputText || i instanceof vscode.TabInputCustom ? [i.uri] : [])
			.filter(u => !seen.has(u.toString()) && !!seen.add(u.toString()));
		if (!uris.length) return void vscode.window.showInformationMessage('Nessun file aperto nell\'editor.');
		const docOf = (u: vscode.Uri) => vscode.workspace.textDocuments.find(d => d.uri.toString() === u.toString());
		let uri = uris[0];
		if (uris.length > 1) {
			const picked = await vscode.window.showQuickPick(uris.map(u => ({
				label: posix.basename(u.path), uri: u,
				description: docOf(u)?.isUntitled ? 'non salvato' : u.scheme === 'file' ? u.fsPath : u.toString(true),
			})), { title: 'Quale file caricare?' });
			if (!picked) return;
			uri = picked.uri;
		}
		const doc = docOf(uri);
		const name = doc?.isUntitled ? await askName('Nome del file da caricare', posix.basename(uri.path)) : posix.basename(uri.path);
		if (!name) return;

		const c = await this.ctx(node);
		if (!c) return;
		const dir = this.dirOf(c.node), remote = posix.join(dir, name);
		// Writing a wsm file over itself would skip the save-time conflict check: that is what Salva is for.
		if (uri.toString() === fileUri(c.s.space.id, remote).toString()) return void vscode.window.showInformationMessage('È lo stesso file: usa Salva.');
		const st = await c.fs.stat(remote).catch(e => { if (!(e instanceof NotFoundError)) throw e; });
		if (st?.type === 'dir') return void vscode.window.showErrorMessage(`Esiste già una cartella con questo nome:\n${remote}`);
		if (st && !await vscode.window.showWarningMessage(`Esiste già:\n${remote}`, { modal: true }, 'Sovrascrivi')) return;
		// Saved local files go byte for byte; edited buffers are encoded as UTF-8 (their original encoding may differ).
		const fromBuffer = !!doc && (doc.isUntitled || doc.isDirty);
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Carico ${remote}...` }, async () => {
			if (fromBuffer) await c.fs.writeFile(remote, new TextEncoder().encode(doc.getText()));
			else if (uri.scheme === 'file') await c.fs.upload(uri.fsPath, remote);
			else await c.fs.writeFile(remote, await vscode.workspace.fs.readFile(uri));
		});
		this.refreshDir(c.s, dir);
		vscode.window.showInformationMessage(`Caricato ${remote}${doc?.isDirty && !doc.isUntitled ? ' (con le modifiche non salvate, in UTF-8)' : ''}.`);
	}

	/** Recursive upload of local files/folders into the node's directory, asking on conflicts. */
	async upload(node: Node, localPaths: string[]) {
		const c = await this.ctx(node);
		if (!c) return;
		const target = this.dirOf(c.node);
		const dirs: string[] = [];
		const jobs: { local: string; remote: string }[] = [];
		let skippedLinks = 0;
		const walk = async (local: string, remote: string) => {
			const ls = await lfs.lstat(local);
			// Symlinked local folders are skipped: they can form cycles. Symlinked files are uploaded normally.
			if (ls.isSymbolicLink() && (await lfs.stat(local)).isDirectory()) { skippedLinks++; return; }
			if (ls.isDirectory()) {
				dirs.push(remote);
				for (const child of await lfs.readdir(local)) await walk(join(local, child), posix.join(remote, child));
			} else jobs.push({ local, remote });
		};
		for (const p of localPaths) await walk(p, posix.join(target, basename(p)));

		// One listing per target folder instead of a stat per file (FTP has no stat: each one would be a LIST).
		// The listing must succeed: without it we can't tell an overwrite from a new file, so the upload stops.
		const names = new Map<string, Promise<Set<string>>>();
		const existsRemote = (path: string) => {
			const dir = posix.dirname(path);
			if (!names.has(dir)) names.set(dir, c.fs.list(dir).then(l => new Set(l.map(e => e.name)), (e: any) => {
				throw new Error(`Impossibile leggere ${dir} per controllare i file esistenti: ${e?.message ?? e}. Upload interrotto.`);
			}));
			return names.get(dir)!.then(set => set.has(posix.basename(path)));
		};
		let policy: 'ask' | 'overwrite' | 'skip' = 'ask';
		let done = 0, skipped = 0;
		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification, title: `Upload su ${c.s.space.name}`, cancellable: true,
			}, async (progress, token) => {
				for (const d of dirs) await mkdirp(c.fs, d);
				for (const job of jobs) {
					if (token.isCancellationRequested) break;
					progress.report({ message: `${done + skipped + 1}/${jobs.length} ${posix.basename(job.remote)}`, increment: 100 / jobs.length });
					if (policy !== 'overwrite' && await existsRemote(job.remote)) {
						let choice = policy === 'skip' ? 'Salta' : await vscode.window.showWarningMessage(
							`Esiste già:\n${job.remote}`, { modal: true }, 'Sovrascrivi', 'Salta', 'Sovrascrivi tutti', 'Salta tutti');
						if (!choice) break;
						if (choice === 'Sovrascrivi tutti') policy = 'overwrite';
						if (choice === 'Salta tutti') { policy = 'skip'; choice = 'Salta'; }
						if (choice === 'Salta') { skipped++; continue; }
					}
					await c.fs.upload(job.local, job.remote);
					done++;
				}
			});
		} finally {
			this.refreshDir(c.s, target); // show what got uploaded even if a file failed midway
		}
		vscode.window.showInformationMessage(`Caricati ${done} file${skipped ? `, saltati ${skipped}` : ''}${skippedLinks ? `, ignorati ${skippedLinks} link a cartelle` : ''}${done + skipped < jobs.length ? ' (interrotto)' : ''}.`);
	}

	async download(node: Node) {
		if (node?.kind !== 'entry') return;
		const c = await this.ctx(node);
		if (!c) return;
		if (node.entry.type === 'file') {
			const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(homedir(), node.entry.name)), saveLabel: 'Scarica' });
			if (!dest) return;
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Scarico ${node.entry.name}...` },
				() => c.fs.download(node.path, dest.fsPath));
			return;
		}
		const [destDir] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Scarica qui' })) ?? [];
		if (!destDir) return;
		let count = 0, links = 0;
		const unsafe: string[] = [];
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Scarico ${node.path}`, cancellable: true },
			async (progress, token) => {
				const walk = async (remote: string, local: string) => {
					await lfs.mkdir(local, { recursive: true });
					for (const e of await c.fs.list(remote)) {
						if (token.isCancellationRequested) return;
						// A name with a separator (e.g. "..\x" is a valid file name on Linux) would escape the destination on Windows.
						if (/[\\/]/.test(e.name)) unsafe.push(e.path);
						// Links to folders are not followed: they may point back up the tree (infinite loop).
						else if (e.type === 'dir' && e.link) links++;
						else if (e.type === 'dir') await walk(e.path, join(local, e.name));
						else {
							progress.report({ message: e.path });
							await c.fs.download(e.path, join(local, e.name));
							count++;
						}
					}
				};
				await walk(node.path, join(destDir.fsPath, node.entry.name));
			});
		vscode.window.showInformationMessage(`Scaricati ${count} file in ${join(destDir.fsPath, node.entry.name)}${links ? ` (ignorati ${links} link a cartelle)` : ''}`);
		if (unsafe.length) {
			vscode.window.showWarningMessage(`${unsafe.length} elementi NON scaricati: il nome contiene "/" o "\\" e finirebbe fuori dalla cartella di destinazione.`,
				{ modal: true, detail: unsafe.slice(0, 20).join('\n') + (unsafe.length > 20 ? `\n... e altri ${unsafe.length - 20}` : '') });
		}
	}
}

async function exists(fs: RemoteFs, path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch (e) {
		if (e instanceof NotFoundError) return false;
		throw e;
	}
}

function askName(prompt: string, value: string) {
	const dot = value.lastIndexOf('.');
	return vscode.window.showInputBox({
		prompt, value,
		valueSelection: dot > 0 ? [0, dot] : undefined,
		validateInput: v => (!v.trim() ? 'Nome obbligatorio' : /[/\\]/.test(v) ? 'Il nome non può contenere / o \\' : v === '.' || v === '..' ? 'Nome non valido' : undefined),
	});
}
