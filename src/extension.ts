import * as vscode from 'vscode';
import { FileOps } from './fileOps';
import { dangerous, newQuery, openTable, runQuery, showCreateTable, sqlTemplate } from './mysql/results';
import { WsmFileSystem } from './remote/fsProvider';
import { Snapshots } from './remote/snapshots';
import { search } from './search';
import { Sessions } from './session';
import { moveSpace, MoveDir } from './spaces';
import { Store } from './store';
import { openTelemetry } from './telemetry/panel';
import { openTerminal } from './terminal';
import { DropController, Node, sortMode, SpacesTree } from './tree';
import { Vault } from './vault';
import { openSpaceForm } from './webview/spaceForm';

export function activate(context: vscode.ExtensionContext) {
	const state = context.globalState;
	const store = new Store(state);
	const vault = new Vault(state, store);
	const sessions = new Sessions(store, vault, state);
	const tree = new SpacesTree(store, sessions);
	const files = new FileOps(sessions, tree);
	const snapshots = new Snapshots(vscode.Uri.joinPath(context.globalStorageUri, 'snapshots'));
	const openWsmUris = () => vscode.window.tabGroups.all.flatMap(g => g.tabs)
		.flatMap(t => t.input instanceof vscode.TabInputText || t.input instanceof vscode.TabInputCustom ? [t.input.uri]
			: t.input instanceof vscode.TabInputTextDiff ? [t.input.original, t.input.modified] : [])
		.filter(u => u.scheme === 'wsm');
	const view = vscode.window.createTreeView('wsm.spaces', {
		treeDataProvider: tree,
		dragAndDropController: new DropController((n, paths) => files.upload(n, paths)),
		canSelectMany: false,
		showCollapseAll: true,
	});
	const formCtx = { store, vault, sessions, state };

	const syncSortContext = () => vscode.commands.executeCommand('setContext', 'wsm.manualSort', sortMode() === 'manual');
	syncSortContext();

	/** Commands get the node from the context menu/inline action, or from the selection when run via keybinding. */
	const cmd = (id: string, fn: (n: Node) => unknown) =>
		vscode.commands.registerCommand(id, async (n?: Node) => {
			const node = n ?? view.selection[0];
			if (!node) return;
			try {
				await fn(node);
			} catch (e: any) {
				vscode.window.showErrorMessage(e?.message ?? String(e));
			}
		});
	const run = (id: string, fn: () => unknown) =>
		vscode.commands.registerCommand(id, async () => {
			try { await fn(); } catch (e: any) { vscode.window.showErrorMessage(e?.message ?? String(e)); }
		});

	const move = (dir: MoveDir) => async (n: Node) => {
		if (n.kind !== 'space' || sortMode() !== 'manual') return;
		await store.saveAll(moveSpace(store.all(), n.spaceId, dir));
		await view.reveal(tree.spaceNode(n.spaceId), { select: true, focus: true });
	};
	const setPinned = (pinned: boolean) => async (n: Node) => {
		const s = n.kind === 'space' && store.get(n.spaceId);
		if (s) await store.upsert({ ...s, pinned });
	};
	// The manual `order` is kept as is while in alpha mode, so switching back restores it.
	const setSort = (mode: 'alpha' | 'manual') => () =>
		vscode.workspace.getConfiguration('wsm').update('sortMode', mode, vscode.ConfigurationTarget.Global);

	context.subscriptions.push(
		view, sessions,
		vscode.workspace.registerFileSystemProvider('wsm', new WsmFileSystem(sessions, snapshots), { isCaseSensitive: true }),
		// Local snapshots live only while their tab is open.
		vscode.window.tabGroups.onDidChangeTabs(e => e.closed.length && snapshots.prune(openWsmUris())),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('wsm.sortMode')) return;
			syncSortContext();
			tree.refresh();
		}),

		run('wsm.addSpace', () => openSpaceForm(formCtx)),
		cmd('wsm.editSpace', n => openSpaceForm(formCtx, n.spaceId)),
		cmd('wsm.deleteSpace', async n => {
			const s = store.get(n.spaceId);
			if (!s) return;
			const ok = await vscode.window.showWarningMessage(`Eliminare lo spazio "${s.name}" e le sue credenziali salvate? (I file sul server non vengono toccati.)`, { modal: true }, 'Elimina');
			if (ok) await store.remove(s.id);
		}),
		cmd('wsm.disconnect', n => sessions.close(n.spaceId)),
		run('wsm.refresh', () => {
			for (const s of sessions.all()) s.invalidate('/');
			tree.refresh();
		}),
		run('wsm.sortAlpha', setSort('alpha')),
		run('wsm.sortManual', setSort('manual')),
		cmd('wsm.moveUp', move('up')),
		cmd('wsm.moveDown', move('down')),
		cmd('wsm.moveTop', move('top')),
		cmd('wsm.moveBottom', move('bottom')),
		cmd('wsm.pin', setPinned(true)),
		cmd('wsm.unpin', setPinned(false)),
		run('wsm.search', () => search(store, sessions, tree, view)),

		run('wsm.export', () => vault.exportSpaces()),
		run('wsm.import', () => vault.importSpaces()),
		run('wsm.changeMasterPassword', () => vault.changePassword()),
		run('wsm.resetVault', async () => { if (await vault.reset()) sessions.closeAll(); }),

		cmd('wsm.refreshNode', n => files.refresh(n)),
		cmd('wsm.openFile', n => files.open(n)),
		cmd('wsm.newFile', n => files.newFile(n)),
		cmd('wsm.newFolder', n => files.newFolder(n)),
		cmd('wsm.rename', n => files.rename(n)),
		cmd('wsm.delete', n => files.delete(n)),
		cmd('wsm.uploadFiles', n => files.uploadPick(n, false)),
		cmd('wsm.uploadFolder', n => files.uploadPick(n, true)),
		cmd('wsm.download', n => files.download(n)),
		cmd('wsm.copyPath', n => files.copyPath(n)),
		cmd('wsm.terminalHere', async n => {
			const s = await sessions.open(n.spaceId);
			if (s && (n.kind === 'filesRoot' || n.kind === 'entry')) openTerminal(s, n.path);
		}),
		cmd('wsm.openTerminal', async n => {
			const s = await sessions.open(n.spaceId);
			if (s) openTerminal(s);
		}),
		cmd('wsm.openTelemetry', n => openTelemetry(sessions, state, n.spaceId)),

		cmd('wsm.newQuery', n => newQuery(n)),
		run('wsm.runQuery', () => runQuery(store, sessions)),
		cmd('wsm.openTable', n => openTable(store, sessions, n)),
		cmd('wsm.showCreateTable', n => showCreateTable(sessions, n)),
		cmd('wsm.newTable', n => sqlTemplate(n, 'newTable')),
		cmd('wsm.addColumn', n => sqlTemplate(n, 'addColumn')),
		cmd('wsm.renameTable', n => sqlTemplate(n, 'renameTable')),
		cmd('wsm.truncateTable', n => dangerous(store, sessions, n, 'truncateTable')),
		cmd('wsm.dropTable', async n => { if (await dangerous(store, sessions, n, 'dropTable')) tree.refresh(tree.getParent(n)); }),
		cmd('wsm.dropDatabase', async n => { if (await dangerous(store, sessions, n, 'dropDatabase')) tree.refresh(tree.getParent(n)); }),
		cmd('wsm.createDatabase', async n => { if (await dangerous(store, sessions, n, 'createDatabase')) tree.refresh(n); }),
	);

	// Tabs restored at startup may still be resolving: prune leftovers a bit later.
	const pruneTimer = setTimeout(() => snapshots.prune(openWsmUris()), 60_000);
	context.subscriptions.push({ dispose: () => clearTimeout(pruneTimer) });
}

export function deactivate() {}
