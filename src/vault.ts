import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMeta, decryptJson, encryptJson, unlock, VaultMeta } from './crypto';
import { newId, nextOrder, Secrets, Space } from './spaces';
import { Store } from './store';

const META_KEY = 'wsm.vault.meta';
const EXPORT_FORMAT = 'webspace-manager';

interface ExportFile {
	format: typeof EXPORT_FORMAT;
	version: 1;
	vault: VaultMeta;
	spaces: Space[];
}

/**
 * Master password handling. The password and derived key are never stored: every unlock prompts again,
 * and a wrong password is detected locally via the verifier before any server is contacted.
 */
export class Vault {
	constructor(private state: vscode.Memento, private store: Store) {}

	private get meta(): VaultMeta | undefined {
		return this.state.get<VaultMeta>(META_KEY);
	}

	/** Prompts for the master password (creating the vault on first use). Undefined if cancelled. */
	async askKey(reason: string): Promise<Buffer | undefined> {
		const meta = this.meta;
		if (!meta) return this.createVault();
		return askUntilValid(meta, `Superpassword per ${reason}`);
	}

	async unlockSecrets(space: Space): Promise<Secrets | undefined> {
		if (!space.secrets) return {};
		const key = await this.askKey(`connettere "${space.name}"`);
		return key && decryptJson<Secrets>(key, space.secrets);
	}

	private async createVault(): Promise<Buffer | undefined> {
		const pw = await askNewPassword('Imposta la superpassword che proteggerà tutte le credenziali');
		if (!pw) return;
		const { meta, key } = await createMeta(pw);
		await this.state.update(META_KEY, meta);
		return key;
	}

	async exportSpaces(): Promise<void> {
		const spaces = this.store.all();
		if (!spaces.length) return void vscode.window.showInformationMessage('Nessuno spazio da esportare.');
		const meta = this.meta;
		// Confirm with the password even though blobs are already encrypted: avoids accidental exports.
		if (meta && !(await askUntilValid(meta, 'Superpassword per esportare gli spazi'))) return;
		const date = new Date().toISOString().slice(0, 10);
		const target = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(join(homedir(), `webspaces-${date}.wsm.json`)),
			filters: { 'WebSpace export': ['json'] },
		});
		if (!target) return;
		const file: ExportFile = { format: EXPORT_FORMAT, version: 1, vault: meta ?? (await this.placeholderMeta()), spaces };
		await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(file, null, 2)));
		vscode.window.showInformationMessage(`Esportati ${spaces.length} spazi. Le credenziali sono cifrate con la superpassword.`);
	}

	/** Export without a vault (no space has secrets yet): a random verifier keeps the file format uniform. */
	private async placeholderMeta(): Promise<VaultMeta> {
		return (await createMeta(newId() + newId())).meta;
	}

	async importSpaces(): Promise<void> {
		const [uri] = (await vscode.window.showOpenDialog({ filters: { 'WebSpace export': ['json'] }, canSelectMany: false })) ?? [];
		if (!uri) return;
		let file: ExportFile;
		try {
			file = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
			const v = file.vault;
			// KDF parameters are bounded: a crafted file must not make scrypt allocate gigabytes (it uses 128*N*r bytes, max 512 MB).
			if (file.format !== EXPORT_FORMAT || !Array.isArray(file.spaces) || typeof v?.salt !== 'string' || typeof v.verifier !== 'string' ||
				!(v.N >= 2 ** 14 && v.N <= 2 ** 20) || !(v.r >= 1 && v.r <= 16) || !(v.p >= 1 && v.p <= 4) ||
				128 * v.N * v.r > 512 * 1024 * 1024) throw new Error();
			if (!file.spaces.every(validSpace)) throw new Error();
		} catch {
			return void vscode.window.showErrorMessage('File non valido: non è un export di WebSpace Manager.');
		}
		let incoming = file.spaces;
		if (incoming.some(s => s.secrets)) {
			const fileKey = await askUntilValid(file.vault, 'Superpassword del file da importare');
			if (!fileKey) return;
			if (!this.meta) {
				// No local vault yet: adopt the file's one, blobs stay valid as they are.
				await this.state.update(META_KEY, file.vault);
			} else {
				const localKey = await this.askKey('salvare gli spazi importati (superpassword locale)');
				if (!localKey) return;
				incoming = incoming.map(s => ({ ...s, secrets: s.secrets && encryptJson(localKey, decryptJson<Secrets>(fileKey, s.secrets)) }));
			}
		}

		const existing = this.store.all();
		const byName = new Map(existing.map(s => [s.name.toLowerCase(), s]));
		const conflicts = incoming.filter(s => byName.has(s.name.toLowerCase())).length;
		let policy: 'skip' | 'overwrite' | 'duplicate' = 'duplicate';
		if (conflicts) {
			const pick = await vscode.window.showQuickPick([
				{ label: 'Salta', description: 'mantieni quelli esistenti', policy: 'skip' as const },
				{ label: 'Sovrascrivi', description: 'sostituisci con quelli importati', policy: 'overwrite' as const },
				{ label: 'Duplica', description: 'importa come nuovi spazi "(importato)"', policy: 'duplicate' as const },
			], { title: `${conflicts} spazi importati hanno lo stesso nome di spazi esistenti`, ignoreFocusOut: true });
			if (!pick) return;
			policy = pick.policy;
		}

		const result = [...existing];
		let order = nextOrder(existing), added = 0;
		for (const s of incoming) {
			const local = byName.get(s.name.toLowerCase());
			if (local && policy === 'skip') continue;
			if (local && policy === 'overwrite') {
				result[result.indexOf(local)] = { ...s, id: local.id, order: local.order, pinned: local.pinned, secrets: s.secrets ?? '' };
			} else {
				result.push({ ...s, id: newId(), order: order++, pinned: !!s.pinned, secrets: s.secrets ?? '', name: local ? `${s.name} (importato)` : s.name });
			}
			added++;
		}
		await this.store.saveAll(result);
		vscode.window.showInformationMessage(`Importati ${added} spazi.`);
	}

	async changePassword(): Promise<void> {
		const meta = this.meta;
		if (!meta) return void vscode.window.showInformationMessage('Nessuna superpassword impostata: verrà chiesta al primo salvataggio di credenziali.');
		const oldKey = await askUntilValid(meta, 'Superpassword attuale');
		if (!oldKey) return;
		const pw = await askNewPassword('Nuova superpassword');
		if (!pw) return;
		const { meta: newMeta, key } = await createMeta(pw);
		const spaces = this.store.all().map(s => ({ ...s, secrets: s.secrets && encryptJson(key, decryptJson<Secrets>(oldKey, s.secrets)) }));
		await this.state.update(META_KEY, newMeta);
		await this.store.saveAll(spaces);
		vscode.window.showInformationMessage('Superpassword cambiata. Ricorda di rifare l\'export se ne conservi uno.');
	}

	async reset(): Promise<boolean> {
		const ok = await vscode.window.showWarningMessage(
			'Reset del vault: verranno cancellate TUTTE le credenziali salvate (password, chiavi). Gli spazi restano, ma dovrai reinserire le credenziali. Continuare?',
			{ modal: true }, 'Cancella credenziali');
		if (!ok) return false;
		await this.state.update(META_KEY, undefined);
		await this.store.saveAll(this.store.all().map(s => ({ ...s, secrets: '' })));
		return true;
	}
}

/** Shape check of imported data (the file comes from outside the extension). */
function validSpace(s: any): s is Space {
	const str = (v: unknown) => typeof v === 'string';
	const port = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536;
	const files = s?.files;
	const mysql = s?.mysql;
	return !!s && str(s.id) && str(s.name) && s.name.trim() !== '' && str(s.secrets ?? '') &&
		(files === undefined || (['sftp', 'ftp'].includes(files.protocol) && ['password', 'key'].includes(files.auth) &&
			str(files.host) && str(files.user) && port(files.port) && str(files.rootPath) && files.rootPath.startsWith('/'))) &&
		(mysql === undefined || (str(mysql.host) && str(mysql.user) && port(mysql.port)));
}

async function askUntilValid(meta: VaultMeta, prompt: string): Promise<Buffer | undefined> {
	for (let msg = prompt; ;) {
		const pw = await vscode.window.showInputBox({ title: 'WebSpace Manager', prompt: msg, password: true, ignoreFocusOut: true });
		if (pw === undefined) return;
		const key = await unlock(pw, meta);
		if (key) return key;
		msg = 'Superpassword errata, riprova (nessuna connessione al server è stata tentata)';
	}
}

async function askNewPassword(prompt: string): Promise<string | undefined> {
	for (;;) {
		const pw = await vscode.window.showInputBox({
			title: 'WebSpace Manager', prompt, password: true, ignoreFocusOut: true,
			validateInput: v => (v.length < 8 ? 'Almeno 8 caratteri' : undefined),
		});
		if (!pw) return;
		const again = await vscode.window.showInputBox({ title: 'WebSpace Manager', prompt: 'Ripeti la superpassword', password: true, ignoreFocusOut: true });
		if (again === undefined) return;
		if (again === pw) {
			vscode.window.showWarningMessage('Se dimentichi la superpassword le credenziali salvate non sono recuperabili.');
			return pw;
		}
		prompt = 'Le due password non coincidono, riprova';
	}
}
