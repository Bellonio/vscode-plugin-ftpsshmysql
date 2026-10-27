import * as vscode from 'vscode';
import { encryptJson } from '../crypto';
import { Session, Sessions } from '../session';
import { FilesConfig, groupNames, MysqlConfig, mysqlKey, newId, nextOrder, Secrets, Space } from '../spaces';
import { Store } from '../store';
import { decryptSecrets, readPrivateKey, Vault } from '../vault';
import { page } from './html';

interface FormData {
	name: string;
	group?: string;
	files?: FilesConfig;
	mysql?: MysqlConfig[];
	/** Only the secret fields the user typed into (empty = unchanged). MySQL passwords under `mysqlKey(id)`. */
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
				panel.webview.postMessage({
					type: 'init', stored: !!old?.secrets, groups: groupNames(ctx.store.all()),
					space: old && { name: old.name, group: old.group, files: old.files, mysql: old.mysql },
				});
			} else if (msg.type === 'pickKey') {
				const [uri] = (await vscode.window.showOpenDialog({ title: 'Chiave privata SSH', canSelectMany: false })) ?? [];
				if (!uri) return;
				pickedKey = await readPrivateKey(uri);
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

const connLabel = (m: MysqlConfig, i: number) => (m.name ? `MySQL "${m.name}"` : `MySQL #${i + 1}`);

function validate(d: FormData): string | undefined {
	if (!d.name.trim()) return 'Il nome è obbligatorio.';
	if (!d.files && !d.mysql?.length) return 'Abilita l\'accesso ai file o aggiungi almeno una connessione MySQL.';
	if (d.files) {
		if (!d.files.host || !d.files.user) return 'File: host e utente sono obbligatori.';
		if (!(d.files.port > 0 && d.files.port < 65536)) return 'File: porta non valida.';
		if (!d.files.rootPath.startsWith('/')) return 'File: la root path deve iniziare con /';
	}
	const ids = new Set<string>();
	for (const [i, m] of (d.mysql ?? []).entries()) {
		const l = connLabel(m, i);
		if (typeof m.id !== 'string' || !m.id || ids.has(m.id)) return `${l}: identificativo non valido.`;
		ids.add(m.id);
		if (!m.host || !m.user) return `${l}: host e utente sono obbligatori.`;
		if (!(m.port > 0 && m.port < 65536)) return `${l}: porta non valida.`;
		if (m.viaSsh && d.files?.protocol !== 'sftp') return `${l}: il tunnel richiede un accesso file di tipo SFTP.`;
	}
}

/** Keeps only the secrets the config actually uses (drops passwords of removed connections and the legacy key). */
function prune(s: Secrets, d: Pick<FormData, 'files' | 'mysql'>): Secrets {
	const out: Secrets = {};
	if (d.files && (d.files.protocol === 'ftp' || d.files.auth === 'password')) out.filesPassword = s.filesPassword;
	if (d.files?.protocol === 'sftp' && d.files.auth === 'key') { out.privateKey = s.privateKey; out.passphrase = s.passphrase; }
	for (const m of d.mysql ?? []) out[mysqlKey(m.id)] = s[mysqlKey(m.id)];
	return typed(out);
}

const typed = (s: Secrets) => Object.fromEntries(Object.entries(s).filter(([, v]) => v)) as Secrets;

async function save(ctx: { store: Store; vault: Vault; sessions: Sessions }, old: Space | undefined, d: FormData): Promise<boolean> {
	const changed = typed(d.secrets);
	let secrets = old?.secrets ?? '';
	// A removed connection must take its password out of the blob too: that needs the key, like a changed secret.
	const removed = (old?.mysql ?? []).some(m => !d.mysql?.some(n => n.id === m.id));
	if (Object.keys(changed).length || (removed && secrets)) {
		const key = await ctx.vault.askKey(`salvare le credenziali di "${d.name}"`);
		if (!key) return false;
		const merged = { ...(old?.secrets ? decryptSecrets(key, old.secrets) : {}), ...changed };
		const kept = prune(merged, d);
		secrets = Object.keys(kept).length ? encryptJson(key, kept) : '';
	}
	const space: Space = {
		id: old?.id ?? newId(),
		name: d.name.trim(),
		group: d.group?.trim() || undefined,
		pinned: old?.pinned ?? false,
		order: old?.order ?? nextOrder(ctx.store.all()),
		files: d.files,
		mysql: d.mysql?.length ? d.mysql : undefined,
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
		secrets = { ...decryptSecrets(key, old.secrets), ...secrets };
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
		for (const [i, m] of (d.mysql ?? []).entries()) {
			try {
				const [rows] = await (await s.getMysql(m.id)).query<any[]>('SELECT VERSION() AS v');
				report.push(`${connLabel(m, i)}: OK (versione ${rows[0]?.v})`);
			} catch (e: any) { ok = false; report.push(`${connLabel(m, i)}: ${e?.message ?? e}`); }
		}
	} finally {
		s.dispose();
	}
	status(ok, report.join('\n'));
}

function html(webview: vscode.Webview): string {
	const css = `
form { max-width: 680px; }
fieldset { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 16px 0; padding: 10px 14px 12px; }
legend { padding: 0 6px; font-weight: 600; }
label.row { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 10px; margin: 6px 0; }
label.check { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
input[type=text], input[type=password], input[type=number], select { width: 100%; }
.hostPort { display: grid; grid-template-columns: 1fr 150px; gap: 10px; }
.hostPort label.row:last-child { grid-template-columns: auto 1fr; }
#mysqlList { counter-reset: conn; }
.card { counter-increment: conn; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 12px; margin: 10px 0; background: var(--vscode-sideBar-background, transparent); }
.cardHead { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.cardHead .num::before { content: '#' counter(conn); font-weight: 600; }
.cardHead .num { min-width: 28px; }
.cardHead button { padding: 4px 10px; }
#mysqlEmpty { margin: 6px 0; }
.actions { display: flex; gap: 8px; margin-top: 16px; }
#status { white-space: pre-wrap; margin-top: 12px; }
.hidden { display: none !important; }`;
	const body = `
<h2 id="title">Spazio</h2>
<form id="f" autocomplete="off">
<label class="row">Nome <input type="text" id="name" required></label>
<label class="row">Cartella <input type="text" id="group" list="groups" placeholder="nessuna (scegli o scrivi un nome nuovo)"></label>
<datalist id="groups"></datalist>

<fieldset><legend><label class="check"><input type="checkbox" id="filesOn" checked> Accesso ai file</label></legend>
<div id="filesBox">
	<label class="row">Protocollo <select id="protocol"><option value="sftp">SFTP (SSH)</option><option value="ftp">FTP</option></select></label>
	<div class="hostPort"><label class="row">Host <input type="text" id="host"></label><label class="row">Porta <input type="number" id="port" value="22"></label></div>
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

<fieldset id="mysqlBox"><legend>Database MySQL</legend>
	<div id="mysqlList"></div>
	<p id="mysqlEmpty" class="muted">Nessuna connessione MySQL.</p>
	<button type="button" class="secondary" id="addMysql">+ Aggiungi connessione MySQL</button>
</fieldset>

<template id="mysqlTpl"><div class="card">
	<div class="cardHead"><span class="num"></span><input type="text" class="mName" placeholder="Nome connessione (opzionale, es. produzione)">
		<button type="button" class="secondary mRemove" title="Rimuovi questa connessione">Rimuovi</button></div>
	<label class="check sftpOnly"><input type="checkbox" class="mViaSsh" checked> Tramite tunnel SSH dello spazio</label>
	<div class="hostPort"><label class="row">Host <input type="text" class="mHost" value="127.0.0.1"></label><label class="row">Porta <input type="number" class="mPort" value="3306"></label></div>
	<label class="row">Utente <input type="text" class="mUser"></label>
	<label class="row">Password <input type="password" class="mPassword"></label>
	<label class="row">Database (opzionale) <input type="text" class="mDatabase"></label>
</div></template>

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
	const sftpFiles = sftp && $('filesOn').checked;
	document.querySelectorAll('.sftpOnly').forEach(e => e.classList.toggle('hidden', e.closest('#mysqlBox') ? !sftpFiles : !sftp));
	document.querySelectorAll('.ftpOnly').forEach(e => e.classList.toggle('hidden', sftp));
	document.querySelectorAll('.ftpsOnly').forEach(e => e.classList.toggle('hidden', sftp || !$('ftps').checked));
	document.querySelectorAll('.keyOnly').forEach(e => e.classList.toggle('hidden', !(sftp && key)));
	document.querySelectorAll('.pwOnly').forEach(e => e.classList.toggle('hidden', sftp && key));
	$('mysqlEmpty').classList.toggle('hidden', !!$('mysqlList').children.length);
}
['filesOn', 'protocol', 'auth', 'ftps'].forEach(id => $(id).addEventListener('change', sync));
$('protocol').addEventListener('change', () => { if (!portTouched) $('port').value = $('protocol').value === 'sftp' ? 22 : 21; });

/** Adds a MySQL card; m = saved connection (its password stays unchanged when the field is left empty). */
function addMysql(m, stored) {
	const card = $('mysqlTpl').content.firstElementChild.cloneNode(true);
	const q = c => card.querySelector('.' + c);
	card.dataset.id = m?.id ?? crypto.randomUUID();
	if (m) {
		q('mName').value = m.name ?? ''; q('mViaSsh').checked = !!m.viaSsh; q('mHost').value = m.host; q('mPort').value = m.port;
		q('mUser').value = m.user; q('mDatabase').value = m.database ?? '';
		if (stored) q('mPassword').placeholder = '(invariata se vuoto)';
	}
	q('mRemove').addEventListener('click', () => { card.remove(); sync(); });
	$('mysqlList').appendChild(card);
	sync();
	return card;
}
$('addMysql').addEventListener('click', () => addMysql().querySelector('.mUser').focus());

function collect() {
	const sftp = $('protocol').value === 'sftp', filesOn = $('filesOn').checked;
	const secrets = { filesPassword: $('filesPassword').value, passphrase: $('passphrase').value };
	const mysql = [...$('mysqlList').children].map(card => {
		const q = c => card.querySelector('.' + c);
		secrets['mysqlPassword:' + card.dataset.id] = q('mPassword').value;
		return {
			id: card.dataset.id, name: q('mName').value.trim() || undefined,
			host: q('mHost').value.trim(), port: Number(q('mPort').value), user: q('mUser').value.trim(),
			database: q('mDatabase').value.trim() || undefined, viaSsh: sftp && filesOn && q('mViaSsh').checked,
		};
	});
	return {
		name: $('name').value,
		group: $('group').value.trim() || undefined,
		files: filesOn ? {
			protocol: $('protocol').value, host: $('host').value.trim(), port: Number($('port').value), user: $('user').value.trim(),
			auth: sftp ? $('auth').value : 'password', rootPath: $('rootPath').value.trim() || '/',
			ftps: !sftp && $('ftps').checked, ftpsInsecure: !sftp && $('ftps').checked && $('ftpsInsecure').checked, showHidden: $('showHidden').checked,
		} : undefined,
		mysql: mysql.length ? mysql : undefined,
		secrets,
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
		for (const g of m.groups) { const o = document.createElement('option'); o.value = g; $('groups').appendChild(o); }
		if (s) {
			$('name').value = s.name;
			$('group').value = s.group ?? '';
			$('filesOn').checked = !!s.files;
			if (s.files) {
				portTouched = true;
				for (const k of ['protocol', 'host', 'port', 'user', 'auth', 'rootPath']) $(k).value = s.files[k] ?? '';
				$('ftps').checked = !!s.files.ftps; $('ftpsInsecure').checked = !!s.files.ftpsInsecure; $('showHidden').checked = !!s.files.showHidden;
			}
			for (const c of s.mysql ?? []) addMysql(c, m.stored);
			if (m.stored) {
				for (const f of ['filesPassword', 'passphrase']) $(f).placeholder = '(invariata se vuoto)';
				$('keyName').textContent = '(invariata se non scegli un nuovo file)';
			}
		}
		sync();
		$('name').focus();
	}
});
sync();
vscode.postMessage({ type: 'ready' });`;
	return page(webview, 'Spazio', css, body, script);
}
