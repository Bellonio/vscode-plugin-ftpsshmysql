import * as vscode from 'vscode';
import { decryptJson, encryptJson } from '../crypto';
import { Session, Sessions } from '../session';
import { FilesConfig, MysqlConfig, newId, nextOrder, SECRET_FIELDS, Secrets, Space } from '../spaces';
import { Store } from '../store';
import { Vault } from '../vault';
import { page } from './html';

interface FormData {
	name: string;
	files?: FilesConfig;
	mysql?: MysqlConfig;
	/** Only the secret fields the user typed into (empty = unchanged). */
	secrets: Secrets;
}

const open = new Map<string, vscode.WebviewPanel>();

export function openSpaceForm(ctx: { store: Store; vault: Vault; sessions: Sessions; state: vscode.Memento }, spaceId?: string) {
	const key = spaceId ?? 'new';
	const existing = open.get(key);
	if (existing) return existing.reveal();
	const old = spaceId ? ctx.store.get(spaceId) : undefined;
	const panel = vscode.window.createWebviewPanel('wsm.form', old ? `Modifica: ${old.name}` : 'Nuovo spazio',
		vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
	open.set(key, panel);
	panel.onDidDispose(() => open.delete(key));
	let pickedKey: string | undefined; // private key content: never sent to the webview
	const status = (ok: boolean, text: string) => panel.webview.postMessage({ type: 'status', ok, text });

	panel.webview.html = html(panel.webview);
	panel.webview.onDidReceiveMessage(async msg => {
		try {
			if (msg.type === 'ready') {
				// Which fields are set is inside the encrypted blob: without the password we only know "something is stored".
				const stored = Object.fromEntries(SECRET_FIELDS.map(f => [f, !!old?.secrets]));
				panel.webview.postMessage({ type: 'init', space: old && { name: old.name, files: old.files, mysql: old.mysql }, stored });
			} else if (msg.type === 'pickKey') {
				const [uri] = (await vscode.window.showOpenDialog({ title: 'Chiave privata SSH', canSelectMany: false })) ?? [];
				if (!uri) return;
				const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
				if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----|PuTTY-User-Key-File/.test(text)) return status(false, 'Il file non sembra una chiave privata.');
				if (text.startsWith('PuTTY')) return status(false, 'Chiave PuTTY (.ppk): convertila in formato OpenSSH con PuTTYgen (Conversions → Export OpenSSH key).');
				pickedKey = text;
				panel.webview.postMessage({ type: 'keyPicked', name: uri.fsPath });
			} else if (msg.type === 'test' || msg.type === 'save') {
				const data = msg.data as FormData;
				if (pickedKey) data.secrets.privateKey = pickedKey;
				const err = validate(data);
				if (err) return status(false, err);
				if (msg.type === 'test') await test(ctx, old, data, status);
				else if (await save(ctx, old, data)) panel.dispose();
			}
		} catch (e: any) {
			status(false, e?.message ?? String(e));
		}
	});
}

function validate(d: FormData): string | undefined {
	if (!d.name.trim()) return 'Il nome è obbligatorio.';
	if (!d.files && !d.mysql) return 'Abilita almeno l\'accesso ai file o il database.';
	if (d.files) {
		if (!d.files.host || !d.files.user) return 'File: host e utente sono obbligatori.';
		if (!(d.files.port > 0 && d.files.port < 65536)) return 'File: porta non valida.';
		if (!d.files.rootPath.startsWith('/')) return 'File: la root path deve iniziare con /';
	}
	if (d.mysql) {
		if (!d.mysql.host || !d.mysql.user) return 'MySQL: host e utente sono obbligatori.';
		if (!(d.mysql.port > 0 && d.mysql.port < 65536)) return 'MySQL: porta non valida.';
		if (d.mysql.viaSsh && d.files?.protocol !== 'sftp') return 'MySQL: il tunnel richiede un accesso file di tipo SFTP.';
	}
}

/** Keeps only the secrets the config actually uses. */
function prune(s: Secrets, d: Pick<FormData, 'files' | 'mysql'>): Secrets {
	const out: Secrets = {};
	if (d.files && (d.files.protocol === 'ftp' || d.files.auth === 'password')) out.filesPassword = s.filesPassword;
	if (d.files?.protocol === 'sftp' && d.files.auth === 'key') { out.privateKey = s.privateKey; out.passphrase = s.passphrase; }
	if (d.mysql) out.mysqlPassword = s.mysqlPassword;
	return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Secrets;
}

const typed = (s: Secrets) => Object.fromEntries(Object.entries(s).filter(([, v]) => v)) as Secrets;

async function save(ctx: { store: Store; vault: Vault; sessions: Sessions }, old: Space | undefined, d: FormData): Promise<boolean> {
	const changed = typed(d.secrets);
	let secrets = old?.secrets ?? '';
	if (Object.keys(changed).length) {
		const key = await ctx.vault.askKey(`salvare le credenziali di "${d.name}"`);
		if (!key) return false;
		const merged = { ...(old?.secrets ? decryptJson<Secrets>(key, old.secrets) : {}), ...changed };
		const kept = prune(merged, d);
		secrets = Object.keys(kept).length ? encryptJson(key, kept) : '';
	}
	const space: Space = {
		id: old?.id ?? newId(),
		name: d.name.trim(),
		pinned: old?.pinned ?? false,
		order: old?.order ?? nextOrder(ctx.store.all()),
		files: d.files,
		mysql: d.mysql,
		secrets,
	};
	if (old) ctx.sessions.close(old.id); // new config/credentials apply on next connect
	await ctx.store.upsert(space);
	vscode.window.showInformationMessage(`Spazio "${space.name}" salvato.`);
	return true;
}

async function test(ctx: { vault: Vault; state: vscode.Memento }, old: Space | undefined, d: FormData, status: (ok: boolean, t: string) => void) {
	let secrets = typed(d.secrets);
	if (old?.secrets) {
		const key = await ctx.vault.askKey('testare la connessione');
		if (!key) return;
		secrets = { ...decryptJson<Secrets>(key, old.secrets), ...secrets };
	}
	const s = new Session({ id: 'test', name: d.name, pinned: false, order: 0, files: d.files, mysql: d.mysql, secrets: '' }, secrets, ctx.state);
	const report: string[] = [];
	let ok = true;
	status(true, 'Test in corso...');
	try {
		if (d.files) {
			try {
				const n = (await (await s.getFs()).list(d.files.rootPath)).length;
				report.push(`File: OK (${n} elementi in ${d.files.rootPath})`);
			} catch (e: any) { ok = false; report.push(`File: ${e?.message ?? e}`); }
		}
		if (d.mysql) {
			try {
				const [rows] = await (await s.getMysql()).query<any[]>('SELECT VERSION() AS v');
				report.push(`MySQL: OK (versione ${rows[0]?.v})`);
			} catch (e: any) { ok = false; report.push(`MySQL: ${e?.message ?? e}`); }
		}
	} finally {
		s.dispose();
	}
	status(ok, report.join('\n'));
}

function html(webview: vscode.Webview): string {
	const css = `
form { max-width: 640px; }
fieldset { border: 1px solid var(--vscode-panel-border); margin: 14px 0; padding: 10px 14px; }
legend { padding: 0 6px; font-weight: 600; }
label.row { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 10px; margin: 6px 0; }
label.check { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
input[type=text], input[type=password], input[type=number], select { width: 100%; }
.actions { display: flex; gap: 8px; margin-top: 16px; }
#status { white-space: pre-wrap; margin-top: 12px; }
.hidden { display: none !important; }`;
	const body = `
<h2 id="title">Spazio</h2>
<form id="f" autocomplete="off">
<label class="row">Nome <input type="text" id="name" required></label>

<fieldset><legend><label class="check"><input type="checkbox" id="filesOn" checked> Accesso ai file</label></legend>
<div id="filesBox">
	<label class="row">Protocollo <select id="protocol"><option value="sftp">SFTP (SSH)</option><option value="ftp">FTP</option></select></label>
	<label class="row">Host <input type="text" id="host"></label>
	<label class="row">Porta <input type="number" id="port" value="22"></label>
	<label class="row">Utente <input type="text" id="user"></label>
	<label class="row sftpOnly">Autenticazione <select id="auth"><option value="password">Password</option><option value="key">Chiave privata</option></select></label>
	<label class="row pwOnly">Password <input type="password" id="filesPassword"></label>
	<div class="row keyOnly" style="display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:center;margin:6px 0">
		<span>Chiave privata</span><span><button type="button" class="secondary" id="pickKey">Scegli file chiave...</button> <span id="keyName" class="muted"></span></span>
	</div>
	<label class="row keyOnly">Passphrase chiave <input type="password" id="passphrase"></label>
	<label class="row">Root path <input type="text" id="rootPath" value="/" placeholder="/var/www/html"></label>
	<label class="check ftpOnly"><input type="checkbox" id="ftps"> FTPS (TLS esplicito)</label>
	<label class="check ftpOnly ftpsOnly"><input type="checkbox" id="ftpsInsecure"> Accetta certificato non valido (self-signed o intestato al provider)</label>
	<label class="check"><input type="checkbox" id="showHidden"> Mostra file nascosti</label>
</div></fieldset>

<fieldset><legend><label class="check"><input type="checkbox" id="mysqlOn"> Database MySQL</label></legend>
<div id="mysqlBox">
	<label class="check sftpOnly"><input type="checkbox" id="viaSsh" checked> Tramite tunnel SSH dello spazio</label>
	<label class="row">Host <input type="text" id="mHost" value="127.0.0.1"></label>
	<label class="row">Porta <input type="number" id="mPort" value="3306"></label>
	<label class="row">Utente <input type="text" id="mUser"></label>
	<label class="row">Password <input type="password" id="mysqlPassword"></label>
	<label class="row">Database (opzionale) <input type="text" id="database"></label>
</div></fieldset>

<p class="muted">Le password e la chiave vengono cifrate con la superpassword. In modifica, lascia vuoti i campi segreti per non cambiarli.</p>
<div class="actions"><button type="submit">Salva</button><button type="button" class="secondary" id="test">Test connessione</button></div>
<div id="status"></div>
</form>`;
	const script = `
const $ = id => document.getElementById(id);
const status = (ok, text) => { $('status').textContent = text; $('status').className = ok ? 'muted' : 'error'; };
let portTouched = false;
$('port').addEventListener('input', () => portTouched = true);

function sync() {
	const sftp = $('protocol').value === 'sftp', key = $('auth').value === 'key';
	$('filesBox').classList.toggle('hidden', !$('filesOn').checked);
	$('mysqlBox').classList.toggle('hidden', !$('mysqlOn').checked);
	const sftpFiles = sftp && $('filesOn').checked;
	document.querySelectorAll('.sftpOnly').forEach(e => e.classList.toggle('hidden', e.closest('#mysqlBox') ? !sftpFiles : !sftp));
	document.querySelectorAll('.ftpOnly').forEach(e => e.classList.toggle('hidden', sftp));
	document.querySelectorAll('.ftpsOnly').forEach(e => e.classList.toggle('hidden', sftp || !$('ftps').checked));
	document.querySelectorAll('.keyOnly').forEach(e => e.classList.toggle('hidden', !(sftp && key)));
	document.querySelectorAll('.pwOnly').forEach(e => e.classList.toggle('hidden', sftp && key));
}
['filesOn', 'mysqlOn', 'protocol', 'auth', 'ftps'].forEach(id => $(id).addEventListener('change', sync));
$('protocol').addEventListener('change', () => { if (!portTouched) $('port').value = $('protocol').value === 'sftp' ? 22 : 21; });

function collect() {
	const sftp = $('protocol').value === 'sftp';
	return {
		name: $('name').value,
		files: $('filesOn').checked ? {
			protocol: $('protocol').value, host: $('host').value.trim(), port: Number($('port').value), user: $('user').value.trim(),
			auth: sftp ? $('auth').value : 'password', rootPath: $('rootPath').value.trim() || '/',
			ftps: !sftp && $('ftps').checked, ftpsInsecure: !sftp && $('ftps').checked && $('ftpsInsecure').checked, showHidden: $('showHidden').checked,
		} : undefined,
		mysql: $('mysqlOn').checked ? {
			host: $('mHost').value.trim(), port: Number($('mPort').value), user: $('mUser').value.trim(),
			database: $('database').value.trim() || undefined, viaSsh: sftp && $('filesOn').checked && $('viaSsh').checked,
		} : undefined,
		secrets: { filesPassword: $('filesPassword').value, passphrase: $('passphrase').value, mysqlPassword: $('mysqlPassword').value },
	};
}

$('f').addEventListener('submit', e => { e.preventDefault(); vscode.postMessage({ type: 'save', data: collect() }); });
$('test').addEventListener('click', () => vscode.postMessage({ type: 'test', data: collect() }));
$('pickKey').addEventListener('click', () => vscode.postMessage({ type: 'pickKey' }));

window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'status') status(m.ok, m.text);
	if (m.type === 'keyPicked') $('keyName').textContent = 'Caricata: ' + m.name;
	if (m.type === 'init') {
		const s = m.space;
		$('title').textContent = s ? 'Modifica spazio' : 'Nuovo spazio';
		if (s) {
			$('name').value = s.name;
			$('filesOn').checked = !!s.files;
			if (s.files) {
				portTouched = true;
				for (const k of ['protocol', 'host', 'port', 'user', 'auth', 'rootPath']) $(k).value = s.files[k] ?? '';
				$('ftps').checked = !!s.files.ftps; $('ftpsInsecure').checked = !!s.files.ftpsInsecure; $('showHidden').checked = !!s.files.showHidden;
			}
			$('mysqlOn').checked = !!s.mysql;
			if (s.mysql) {
				$('mHost').value = s.mysql.host; $('mPort').value = s.mysql.port; $('mUser').value = s.mysql.user;
				$('database').value = s.mysql.database ?? ''; $('viaSsh').checked = !!s.mysql.viaSsh;
			}
			for (const f of ['filesPassword', 'passphrase', 'mysqlPassword']) if (m.stored[f]) $(f).placeholder = '(invariata se vuoto)';
			if (m.stored.privateKey) $('keyName').textContent = '(invariata se non scegli un nuovo file)';
		}
		sync();
		$('name').focus();
	}
});
sync();
vscode.postMessage({ type: 'ready' });`;
	return page(webview, 'Spazio', css, body, script);
}
