import * as vscode from 'vscode';
import { posix } from 'node:path';
import { Sessions } from './session';
import { sortSpaces } from './spaces';
import { Store } from './store';
import { Node, sortMode, SpacesTree } from './tree';

interface Item extends vscode.QuickPickItem {
	target: () => Node | undefined;
	isFile?: boolean;
}

/** Fuzzy search over spaces and the remote entries already loaded in the tree. Never contacts a server. */
export async function search(store: Store, sessions: Sessions, tree: SpacesTree, view: vscode.TreeView<Node>) {
	const items: Item[] = sortSpaces(store.all(), sortMode()).map(s => ({
		label: `$(vm) ${s.name}`,
		description: [s.files && `${s.files.user}@${s.files.host}`, s.mysql && `db ${s.mysql.host}`].filter(Boolean).join(' · '),
		target: () => tree.spaceNode(s.id),
	}));
	for (const s of sessions.all()) {
		for (const entries of s.cache.values()) {
			for (const e of entries) {
				items.push({
					label: `${e.type === 'dir' ? '$(folder)' : '$(file)'} ${e.name}`,
					description: `${s.space.name} · ${posix.dirname(e.path)}`,
					target: () => tree.entryNode(s.space.id, e),
					isFile: e.type === 'file',
				});
			}
		}
	}
	const pick = await vscode.window.showQuickPick(items, {
		title: 'Cerca spazi e file già caricati',
		placeHolder: 'Nome spazio, host, file o cartella (solo cartelle già aperte nell\'albero)',
		matchOnDescription: true,
	});
	const node = pick?.target();
	if (!node) return;
	await view.reveal(node, { select: true, focus: true, expand: node.kind === 'entry' && !pick!.isFile });
	if (pick!.isFile) vscode.commands.executeCommand('wsm.openFile', node);
}
