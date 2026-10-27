import * as vscode from 'vscode';
import { posix } from 'node:path';
import { Sessions } from './session';
import { applyFilter, groupNames, sortSpaces } from './spaces';
import { Store } from './store';
import { Node, sortMode, spaceIcon, SpacesTree } from './tree';

interface Item extends vscode.QuickPickItem {
	target?: () => Node | undefined;
	isFile?: boolean;
}

const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });

/** Fuzzy search over spaces and the remote entries already loaded in the tree. Never contacts a server. */
export async function search(store: Store, sessions: Sessions, tree: SpacesTree, view: vscode.TreeView<Node>) {
	// Only what the filter shows: a hidden space can't be revealed.
	const spaces = sortSpaces(applyFilter(store.all(), tree.filter), sortMode());
	const visible = new Set(spaces.map(s => s.id));
	// Three kinds of rows, each under its own separator and with its own icon, as in the sidebar:
	// folders of spaces ($(folder-library)), spaces (protocol icon), remote files/folders of open spaces (one section per space).
	// A space shows its folder in the description, so typing a folder name also lists its spaces.
	const items: Item[] = [];
	const folders = groupNames(spaces);
	if (folders.length) items.push(separator('Cartelle di spazi'), ...folders.map(g => {
		const n = spaces.filter(s => s.group === g).length;
		return { label: `$(folder-library) ${g}`, description: `${n} ${n === 1 ? 'spazio' : 'spazi'}`, target: () => tree.groupNode(g) };
	}));
	if (spaces.length) items.push(separator('Spazi'), ...spaces.map(s => ({
		label: `$(${spaceIcon(s)}) ${s.name}`,
		description: [s.group && `$(folder-library) ${s.group}`, s.files && `${s.files.user}@${s.files.host}`, ...(s.mysql ?? []).map(m => `db ${m.name || m.host}`)].filter(Boolean).join(' · '),
		target: () => tree.spaceNode(s.id),
	})));
	for (const s of sessions.all()) {
		if (!visible.has(s.space.id)) continue;
		const entries = [...s.cache.values()].flat();
		if (!entries.length) continue;
		items.push(separator(`File in "${s.space.name}"`), ...entries.map(e => ({
			label: `${e.type === 'dir' ? '$(folder)' : '$(file)'} ${e.name}`,
			description: `${s.space.name} › ${posix.dirname(e.path)}`,
			target: () => tree.entryNode(s.space.id, e),
			isFile: e.type === 'file',
		})));
	}
	const pick = await vscode.window.showQuickPick(items, {
		title: 'Cerca spazi e file già caricati',
		placeHolder: 'Nome spazio, host, file o cartella (solo cartelle già aperte nell\'albero)',
		matchOnDescription: true,
	});
	const node = pick?.target?.();
	if (!node) return;
	await view.reveal(node, { select: true, focus: true, expand: node.kind === 'group' || (node.kind === 'entry' && !pick!.isFile) });
	if (pick!.isFile) vscode.commands.executeCommand('wsm.openFile', node);
}
