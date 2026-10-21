import * as vscode from 'vscode';
import { Space } from './spaces';

const KEY = 'wsm.spaces';

/** Spaces persisted in globalState: config in clear, secrets only as an encrypted blob. */
export class Store {
	private changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(private state: vscode.Memento) {}

	all(): Space[] {
		return this.state.get<Space[]>(KEY, []);
	}

	get(id: string): Space | undefined {
		return this.all().find(s => s.id === id);
	}

	async saveAll(list: Space[]): Promise<void> {
		await this.state.update(KEY, list);
		this.changed.fire();
	}

	async upsert(space: Space): Promise<void> {
		const list = this.all();
		const i = list.findIndex(s => s.id === space.id);
		if (i >= 0) list[i] = space; else list.push(space);
		await this.saveAll(list);
	}

	async remove(id: string): Promise<void> {
		await this.saveAll(this.all().filter(s => s.id !== id));
	}
}
