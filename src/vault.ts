import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMeta, decryptJson, encryptJson, unlock, VaultMeta } from './crypto';
import { newId, nextOrder, SECRET_FIELDS, Secrets, Space, stripSecrets } from './spaces';
import { Store } from './store';

const META_KEY = 'wsm.vault.meta';
const EXPORT_FORMAT = 'webspace-manager';

interface ExportFile {
	format: typeof EXPORT_FORMAT;
	version: 1;
	vault: VaultMeta;
	spaces: Space[];
	/** Export for a colleague: `vault` is the delivery password, spaces may have `missing` secrets. */
	shared?: boolean;
}

const SECRET_LABELS: Record<keyof Secrets, string> = {
	filesPassword: 'Password FTP/SSH', privateKey: 'Chiave privata SSH', passphrase: 'Passphrase della chiave', mysqlPassword: 'Password MySQL',
};

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
		const mode = await vscode.window.showQuickPick([
			{ label: 'Backup personale', description: 'credenziali cifrate con la tua superpassword', shared: false },
			{ label: 'Per un collega', description: 'password di consegna diversa, segreti a scelta tolti', shared: true },
		], { title: 'Esporta spazi', ignoreFocusOut: true });
		if (!mode) return;
		if (mode.shared) return this.exportShared(spaces);
		const meta = this.meta;
		// Confirm with the password even though blobs are already encrypted: avoids accidental exports.
		if (meta && !(await askUntilValid(meta, 'Superpassword per esportare gli spazi'))) return;
		const file: ExportFile = { format: EXPORT_FORMAT, version: 1, vault: meta ?? (await this.placeholderMeta()), spaces };
		if (await writeExport(file, 'webspaces'))
			vscode.window.showInformationMessage(`Esportati ${spaces.length} spazi. Le credenziali sono cifrate con la superpassword.`);
	}

	/** Export for a colleague: blobs re-encrypted with a delivery password, chosen secrets removed and marked in `missing`. */
	private async exportShared(all: Space[]): Promise<void> {
		const picked = await vscode.window.showQuickPick(all.map(s => ({ label: s.name, picked: true, space: s })),
			{ title: 'Spazi da consegnare', canPickMany: true, ignoreFocusOut: true });
		if (!picked?.length) return;
		const strip = await vscode.window.showQuickPick([
			{ label: 'Chiave privata SSH e passphrase', picked: true, fields: ['privateKey', 'passphrase'] as (keyof Secrets)[] },
			{ label: 'Password FTP/SSH', fields: ['filesPassword'] as (keyof Secrets)[] },
			{ label: 'Password MySQL', fields: ['mysqlPassword'] as (keyof Secrets)[] },
		], { title: 'Segreti da togliere (il collega li inserirà all\'import)', canPickMany: true, ignoreFocusOut: true });
		if (!strip) return;
		const spaces = picked.map(p => p.space);
		const meta = this.meta;
		let myKey: Buffer | undefined;
		if (meta && spaces.some(s => s.secrets) && !(myKey = await askUntilValid(meta, 'Superpassword per esportare gli spazi'))) return;
		let pw: string | undefined;
		for (;;) {
			pw = await askNewPassword('Password di consegna per il collega', false);
			if (!pw) return;
			if (!meta || !(await unlock(pw, meta))) break;
			vscode.window.showWarningMessage('È la tua superpassword: scegline una diversa per il collega.');
		}
		const { meta: shareMeta, key } = await createMeta(pw);
		const stripped = stripSecrets(spaces.map(s => (s.secrets ? decryptJson<Secrets>(myKey!, s.secrets) : {})), strip.flatMap(p => p.fields));
		const out = spaces.map((s, i) => {
			const { kept, missing } = stripped[i];
			return { ...s, secrets: Object.keys(kept).length ? encryptJson(key, kept) : '', missing: Object.keys(missing).length ? missing : undefined };
		});
		const file: ExportFile = { format: EXPORT_FORMAT, version: 1, vault: shareMeta, spaces: out, shared: true };
		if (await writeExport(file, 'webspaces-collega'))
			vscode.window.showInformationMessage(`Esportati ${out.length} spazi per il collega. Mandagli la password di consegna su un canale diverso da quello del file.`);
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
		// Name conflicts first, so skipped spaces don't cost password or secret prompts.
		const existing = this.store.all();
		const byName = new Map(existing.map(s => [s.name.toLowerCase(), s]));
		const conflicts = file.spaces.filter(s => byName.has(s.name.toLowerCase())).length;
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

		let incoming = policy === 'skip' ? file.spaces.filter(s => !byName.has(s.name.toLowerCase())) : file.spaces;
		let incomplete: string[] = [];
		if (file.shared) {
			const r = await this.receiveShared(incoming, file.vault);
			if (!r) return;
			({ spaces: incoming, incomplete } = r);
		} else if (incoming.some(s => s.secrets)) {
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
		incoming = incoming.map(({ missing, ...s }) => s);

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
		if (incomplete.length)
			vscode.window.showWarningMessage(`Importati ${added} spazi. Senza alcune credenziali (aggiungile modificando lo spazio): ${incomplete.join(', ')}.`);
		else vscode.window.showInformationMessage(`Importati ${added} spazi.`);
	}

	/**
	 * File from a colleague: decrypts with the delivery password, asks the removed secrets once per value and
	 * re-encrypts everything with the local key. Always the local vault (created if missing): adopting the file's
	 * one would make the sender's delivery password our master password.
	 */
	private async receiveShared(spaces: Space[], vault: VaultMeta): Promise<{ spaces: Space[]; incomplete: string[] } | undefined> {
		if (!spaces.some(s => s.secrets || s.missing)) return { spaces, incomplete: [] };
		let fileKey: Buffer | undefined;
		if (spaces.some(s => s.secrets) && !(fileKey = await askUntilValid(vault, 'Password di consegna del file da importare'))) return;
		const localKey = await this.askKey('salvare gli spazi importati (superpassword locale)');
		if (!localKey) return;
		const given = await askMissing(spaces);
		const incomplete: string[] = [];
		const out = spaces.map(s => {
			const secrets: Secrets = s.secrets ? decryptJson<Secrets>(fileKey!, s.secrets) : {};
			for (const [f, id] of Object.entries(s.missing ?? {}) as [keyof Secrets, string][]) {
				const v = given.get(`${f}\0${id}`);
				if (v) secrets[f] = v;
				else if (!incomplete.includes(s.name)) incomplete.push(s.name);
			}
			return { ...s, secrets: Object.keys(secrets).length ? encryptJson(localKey, secrets) : '' };
		});
		return { spaces: out, incomplete };
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
		(mysql === undefined || (str(mysql.host) && str(mysql.user) && port(mysql.port))) &&
		(s.missing === undefined || (typeof s.missing === 'object' && s.missing !== null &&
			Object.entries(s.missing).every(([k, v]) => SECRET_FIELDS.includes(k as keyof Secrets) && str(v))));
}

async function writeExport(file: ExportFile, baseName: string): Promise<boolean> {
	const date = new Date().toISOString().slice(0, 10);
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(join(homedir(), `${baseName}-${date}.wsm.json`)),
		filters: { 'WebSpace export': ['json'] },
	});
	if (!target) return false;
	await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(file, null, 2)));
	return true;
}

/** Asks each removed secret once per group (same value in the sender's spaces), naming the spaces that use it. Esc skips it. */
async function askMissing(spaces: Space[]): Promise<Map<string, string>> {
	const groups = new Map<string, { field: keyof Secrets; id: string; names: string[]; passphrase: boolean }>();
	for (const s of spaces) {
		for (const [field, id] of Object.entries(s.missing ?? {}) as [keyof Secrets, string][]) {
			if (field === 'passphrase') continue; // asked right after its key
			const k = `${field}\0${id}`;
			const g = groups.get(k) ?? { field, id, names: [], passphrase: false };
			g.names.push(s.name);
			g.passphrase ||= s.missing!.passphrase === id;
			groups.set(k, g);
		}
	}
	const given = new Map<string, string>();
	for (const [k, g] of groups) {
		const forWho = `per: ${g.names.join(', ')}`;
		const v = g.field === 'privateKey' ? await askKeyFile(`${SECRET_LABELS.privateKey} ${forWho}`) : await askSecret(`${SECRET_LABELS[g.field]} ${forWho}`);
		if (!v) continue;
		given.set(k, v);
		if (g.field === 'privateKey' && g.passphrase) {
			const p = await askSecret(`${SECRET_LABELS.passphrase} ${forWho}`);
			if (p) given.set(`passphrase\0${g.id}`, p);
		}
	}
	return given;
}

async function askSecret(prompt: string): Promise<string | undefined> {
	return (await vscode.window.showInputBox({ title: 'WebSpace Manager', prompt: `${prompt} (Esc per saltare)`, password: true, ignoreFocusOut: true })) || undefined;
}

async function askKeyFile(title: string): Promise<string | undefined> {
	for (;;) {
		const [uri] = (await vscode.window.showOpenDialog({ title: `${title} (annulla per saltare)`, canSelectMany: false })) ?? [];
		if (!uri) return;
		try {
			return await readPrivateKey(uri);
		} catch (e) {
			vscode.window.showErrorMessage((e as Error).message);
		}
	}
}

/** Reads an OpenSSH private key file, throwing a message for the user if it isn't one. */
export async function readPrivateKey(uri: vscode.Uri): Promise<string> {
	const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----|PuTTY-User-Key-File/.test(text)) throw new Error('Il file non sembra una chiave privata.');
	if (text.startsWith('PuTTY')) throw new Error('Chiave PuTTY (.ppk): convertila in formato OpenSSH con PuTTYgen (Conversions → Export OpenSSH key).');
	return text;
}

async function askUntilValid(meta: VaultMeta, prompt: string): Promise<Buffer | undefined> {
	for (let msg = prompt; ;) {
		const pw = await vscode.window.showInputBox({ title: 'WebSpace Manager', prompt: msg, password: true, ignoreFocusOut: true });
		if (pw === undefined) return;
		const key = await unlock(pw, meta);
		if (key) return key;
		msg = 'Password errata, riprova (nessuna connessione al server è stata tentata)';
	}
}

async function askNewPassword(prompt: string, master = true): Promise<string | undefined> {
	for (;;) {
		const pw = await vscode.window.showInputBox({
			title: 'WebSpace Manager', prompt, password: true, ignoreFocusOut: true,
			validateInput: v => (v.length < 8 ? 'Almeno 8 caratteri' : undefined),
		});
		if (!pw) return;
		const again = await vscode.window.showInputBox({ title: 'WebSpace Manager', prompt: 'Ripeti la password', password: true, ignoreFocusOut: true });
		if (again === undefined) return;
		if (again === pw) {
			if (master) vscode.window.showWarningMessage('Se dimentichi la superpassword le credenziali salvate non sono recuperabili.');
			return pw;
		}
		prompt = 'Le due password non coincidono, riprova';
	}
}
