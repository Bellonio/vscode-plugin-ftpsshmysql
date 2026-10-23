import * as vscode from 'vscode';
import { posix } from 'node:path';
import { Entry, normalize } from './remote/remoteFs';
import { Session, Sessions } from './session';
import { SortMode, sortSpaces, Space } from './spaces';
import { Store } from './store';

export type Node =
	| { kind: 'space'; id: string; spaceId: string }
	| { kind: 'filesRoot'; id: string; spaceId: string; path: string }
	| { kind: 'entry'; id: string; spaceId: string; path: string; entry: Entry }
	| { kind: 'terminal'; id: string; spaceId: string }
	| { kind: 'telemetry'; id: string; spaceId: string }
	| { kind: 'db'; id: string; spaceId: string }
	| { kind: 'database'; id: string; spaceId: string; database: string }
	| { kind: 'table'; id: string; spaceId: string; database: string; table: string }
	/** Column or index of a table (read-only info). */
	| { kind: 'tableInfo'; id: string; spaceId: string; database: string; table: string; text: string; description: string; tooltip: string; icon: string; contextValue: string }
	| { kind: 'message'; id: string; spaceId: string; text: string };

export const fileUri = (spaceId: string, path: string) => vscode.Uri.from({ scheme: 'wsm', authority: spaceId, path });

export function sortMode(): SortMode {
	return vscode.workspace.getConfiguration('wsm').get<SortMode>('sortMode', 'alpha');
}

/**
 * Rules that make accidental connections impossible:
 * - no `command` on spaces/folders, so a click (or the mouse-up of a failed drag) does nothing but select;
 * - every container starts collapsed and constructors do no I/O;
 * - a connection is opened only when the user expands "File" or "DB", or runs an explicit action.
 */
export class SpacesTree implements vscode.TreeDataProvider<Node> {
	private changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	/** Nodes are cached by id so that reveal/refresh receive the same objects the view knows. */
	private nodes = new Map<string, Node>();
	/**
	 * Child node ids carry a nonce that changes at every activation and every disconnect: VSCode restores the
	 * expanded state by id, and a restored "File" node would otherwise connect (and ask the password) on its own.
	 */
	private nonces = new Map<string, string>();
	private boot = Date.now().toString(36);

	private p(spaceId: string) {
		return `${spaceId}|${this.nonces.get(spaceId) ?? this.boot}`;
	}

	constructor(private store: Store, private sessions: Sessions) {
		store.onDidChange(() => this.refresh());
		sessions.onDidChange(id => {
			const space = this.nodes.get(id);
			const s = sessions.get(id);
			if (!s) {
				// New child ids: the disconnected space's expanded folders come back collapsed, without reconnecting.
				this.dropSpaceNodes(id);
				this.nonces.set(id, Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
			}
			this.changed.fire(space);
		});
	}

	refresh(node?: Node) {
		this.changed.fire(node);
	}

	private node<T extends Node>(n: T): T {
		const cached = this.nodes.get(n.id) as T | undefined;
		if (cached) return Object.assign(cached, n);
		this.nodes.set(n.id, n);
		return n;
	}

	private dropSpaceNodes(spaceId: string) {
		for (const [id, n] of this.nodes) if (n.spaceId === spaceId && n.kind !== 'space') this.nodes.delete(id);
	}

	spaceNode(spaceId: string) {
		return this.node({ kind: 'space', id: spaceId, spaceId });
	}

	filesRootNode(space: Space) {
		return this.node({ kind: 'filesRoot', id: `${this.p(space.id)}|files`, spaceId: space.id, path: normalize(space.files!.rootPath || '/') });
	}

	entryNode(spaceId: string, entry: Entry) {
		return this.node({ kind: 'entry', id: `${this.p(spaceId)}|f|${entry.path}`, spaceId, path: entry.path, entry });
	}

	/** Node for a directory path: the files root itself or an already-listed folder. */
	dirNode(spaceId: string, path: string): Node | undefined {
		const space = this.store.get(spaceId);
		if (!space?.files) return;
		const root = this.filesRootNode(space);
		return path === root.path ? root : this.nodes.get(`${this.p(spaceId)}|f|${path}`);
	}

	/** The "DB" node of a space, if the view has already created it. */
	dbNode(spaceId: string): Node | undefined {
		return this.nodes.get(`${this.p(spaceId)}|db`);
	}

	getParent(n: Node): Node | undefined {
		switch (n.kind) {
			case 'space': return undefined;
			case 'entry': return this.dirNode(n.spaceId, posix.dirname(n.path));
			case 'database': return this.nodes.get(`${this.p(n.spaceId)}|db`);
			case 'table': return this.nodes.get(`${this.p(n.spaceId)}|db|${n.database}`);
			case 'tableInfo': return this.nodes.get(`${this.p(n.spaceId)}|db|${n.database}|${n.table}`);
			default: return this.spaceNode(n.spaceId);
		}
	}

	getTreeItem(n: Node): vscode.TreeItem {
		const C = vscode.TreeItemCollapsibleState;
		const space = this.store.get(n.spaceId);
		switch (n.kind) {
			case 'space': {
				const connected = !!this.sessions.get(n.spaceId);
				const item = new vscode.TreeItem(space?.name ?? '?', C.Collapsed);
				item.id = n.id;
				item.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'vm-outline');
				item.description = [space?.pinned ? '📌' : '', space?.files ? `${space.files.user}@${space.files.host}` : space?.mysql?.host].filter(Boolean).join(' ');
				item.contextValue = ['space', space?.pinned && 'pinned', connected && 'connected'].filter(Boolean).join(':');
				item.tooltip = connected ? 'Connesso' : 'Non connesso: espandi "File" o "DB" per connetterti';
				return item;
			}
			case 'filesRoot': {
				const f = space!.files!;
				const item = new vscode.TreeItem(`File (${f.protocol.toUpperCase()}${f.ftps ? 'S' : ''})`, C.Collapsed);
				item.id = n.id;
				item.description = n.path;
				item.iconPath = new vscode.ThemeIcon('root-folder');
				item.contextValue = `filesRoot:${f.protocol}`;
				return item;
			}
			case 'entry': {
				const isDir = n.entry.type === 'dir';
				const item = new vscode.TreeItem(n.entry.name, isDir ? C.Collapsed : C.None);
				item.id = n.id;
				item.resourceUri = fileUri(n.spaceId, n.path); // file-type icons from the theme
				item.contextValue = `${isDir ? 'folder' : 'file'}:${space?.files?.protocol}`;
				item.tooltip = `${n.path}${isDir ? '' : `\n${formatSize(n.entry.size)}`}${n.entry.mtime ? `\n${new Date(n.entry.mtime).toLocaleString()}` : ''}`;
				if (n.entry.link) item.description = '→ link';
				if (!isDir) item.command = { command: 'wsm.openFile', title: 'Apri', arguments: [n] };
				return item;
			}
			case 'terminal': {
				const item = new vscode.TreeItem('Terminale', C.None);
				item.id = n.id;
				item.iconPath = new vscode.ThemeIcon('terminal');
				item.command = { command: 'wsm.openTerminal', title: 'Apri terminale', arguments: [n] };
				item.contextValue = 'terminal';
				return item;
			}
			case 'telemetry': {
				const item = new vscode.TreeItem('Telemetria', C.None);
				item.id = n.id;
				item.iconPath = new vscode.ThemeIcon('pulse');
				item.command = { command: 'wsm.openTelemetry', title: 'Apri telemetria', arguments: [n] };
				item.contextValue = 'telemetry';
				return item;
			}
			case 'db': {
				const m = space!.mysql!;
				const item = new vscode.TreeItem('DB MySQL', C.Collapsed);
				item.id = n.id;
				item.description = `${m.user}@${m.host}${m.viaSsh ? ' (tunnel SSH)' : ''}`;
				item.iconPath = new vscode.ThemeIcon('database');
				item.contextValue = 'db';
				return item;
			}
			case 'database': {
				const item = new vscode.TreeItem(n.database, C.Collapsed);
				item.id = n.id;
				item.iconPath = new vscode.ThemeIcon('symbol-namespace');
				item.contextValue = 'database';
				return item;
			}
			case 'table': {
				const item = new vscode.TreeItem(n.table, C.Collapsed);
				item.id = n.id;
				item.iconPath = new vscode.ThemeIcon('table');
				item.contextValue = 'table';
				item.command = { command: 'wsm.openTable', title: 'Mostra righe', arguments: [n] };
				return item;
			}
			case 'tableInfo': {
				const item = new vscode.TreeItem(n.text, C.None);
				item.id = n.id;
				item.description = n.description;
				item.tooltip = n.tooltip;
				item.iconPath = new vscode.ThemeIcon(n.icon);
				item.contextValue = n.contextValue;
				return item;
			}
			case 'message': {
				const item = new vscode.TreeItem(n.text, C.None);
				item.id = n.id;
				item.iconPath = new vscode.ThemeIcon('warning');
				item.tooltip = n.text;
				return item;
			}
		}
	}

	async getChildren(n?: Node): Promise<Node[]> {
		if (!n) return sortSpaces(this.store.all(), sortMode()).map(s => this.spaceNode(s.id));
		const space = this.store.get(n.spaceId);
		if (!space) return [];
		switch (n.kind) {
			case 'space': {
				const out: Node[] = [];
				if (space.files) out.push(this.filesRootNode(space));
				if (space.files?.protocol === 'sftp') out.push(this.node({ kind: 'terminal', id: `${this.p(space.id)}|term`, spaceId: space.id }));
				if (space.mysql) out.push(this.node({ kind: 'db', id: `${this.p(space.id)}|db`, spaceId: space.id }));
				if (space.files?.protocol === 'sftp' || space.mysql) out.push(this.node({ kind: 'telemetry', id: `${this.p(space.id)}|tele`, spaceId: space.id }));
				return out;
			}
			case 'filesRoot':
			case 'entry':
				return this.withSession(n, async s => (await s.list(n.path)).map(e => this.entryNode(space.id, e)));
			case 'db':
				return this.withSession(n, async s => {
					const [rows] = await (await s.getMysql()).query<any[]>({ sql: 'SHOW DATABASES', rowsAsArray: true });
					const dbs = rows.map(r => String(r[0]));
					const only = space.mysql?.database;
					return (only && dbs.includes(only) ? [only, ...dbs.filter(d => d !== only)] : dbs)
						.map(d => this.node({ kind: 'database', id: `${this.p(space.id)}|db|${d}`, spaceId: space.id, database: d }));
				});
			case 'database':
				return this.withSession(n, async s => {
					const conn = await s.getMysql();
					const [rows] = await conn.query<any[]>({ sql: `SHOW FULL TABLES FROM ${conn.escapeId(n.database)}`, rowsAsArray: true });
					return rows.map(r => this.node({ kind: 'table', id: `${this.p(space.id)}|db|${n.database}|${r[0]}`, spaceId: space.id, database: n.database, table: String(r[0]) }));
				});
			case 'table':
				return this.withSession(n, async s => {
					const conn = await s.getMysql();
					const from = `FROM ${conn.escapeId(n.table)} FROM ${conn.escapeId(n.database)}`;
					const [cols] = await conn.query<any[]>(`SHOW FULL COLUMNS ${from}`);
					const [idx] = await conn.query<any[]>(`SHOW INDEX ${from}`);
					const info = (key: string, text: string, description: string, tooltip: string, icon: string, contextValue: string) =>
						this.node({ kind: 'tableInfo', id: `${n.id}|${key}`, spaceId: n.spaceId, database: n.database, table: n.table, text, description, tooltip, icon, contextValue });
					const indexes = new Map<string, any[]>();
					for (const r of idx) indexes.set(r.Key_name, [...(indexes.get(r.Key_name) ?? []), r]);
					return [
						...cols.map(c => info(`c|${c.Field}`, c.Field,
							[c.Type, c.Null === 'NO' && 'NOT NULL', c.Key === 'PRI' && 'PK', c.Extra].filter(Boolean).join(' '),
							[`${c.Field} ${c.Type}`, `Null: ${c.Null}`, c.Default !== null && `Default: ${c.Default}`, c.Collation && `Collation: ${c.Collation}`, c.Comment && `Commento: ${c.Comment}`].filter(Boolean).join('\n'),
							c.Key === 'PRI' ? 'key' : 'symbol-field', 'column')),
						...[...indexes].map(([name, parts]) => info(`i|${name}`, name,
							`(${parts.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(p => p.Column_name).join(', ')})${Number(parts[0].Non_unique) ? '' : ' UNIQUE'}`,
							`Indice ${parts[0].Index_type ?? ''}`, 'list-tree', 'index')),
					];
				});
			default:
				return [];
		}
	}

	/** Opens (or reuses) the session and turns errors into a visible message node instead of an empty folder. */
	private async withSession(n: Node, fn: (s: Session) => Promise<Node[]>): Promise<Node[]> {
		const msg = (text: string) => [this.node({ kind: 'message', id: `${n.id}|msg`, spaceId: n.spaceId, text })];
		try {
			const s = await this.sessions.open(n.spaceId);
			if (!s) return msg('Superpassword non inserita: usa "Aggiorna" su questo nodo per riprovare');
			return await fn(s);
		} catch (e: any) {
			vscode.window.showErrorMessage(`${this.store.get(n.spaceId)?.name}: ${e?.message ?? e}`);
			return msg(e?.message ?? String(e));
		}
	}
}

export function formatSize(n: number): string {
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * Upload by dropping files from the OS / VSCode Explorer. Nodes of this tree can't be dragged at all
 * (no dragMimeTypes, no handleDrag), so moving remote folders by accident is impossible.
 */
export class DropController implements vscode.TreeDragAndDropController<Node> {
	readonly dragMimeTypes: string[] = [];
	readonly dropMimeTypes = ['text/uri-list'];

	constructor(private upload: (target: Node, localPaths: string[]) => Promise<void>) {}

	async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
		if (!target || (target.kind !== 'filesRoot' && target.kind !== 'entry')) return;
		const list = await data.get('text/uri-list')?.asString();
		if (!list) return;
		const paths = list.split(/\r?\n/).filter(l => l && !l.startsWith('#'))
			.map(l => vscode.Uri.parse(l.trim())).filter(u => u.scheme === 'file').map(u => u.fsPath);
		if (paths.length) await this.upload(target, paths);
	}
}
