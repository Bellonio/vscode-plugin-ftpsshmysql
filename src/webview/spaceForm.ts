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
body { padding: 0 20px; }
form { max-width: 1240px; }
.page { padding: 18px 0 4px; }
.page h1 { font-size: 1.45em; font-weight: 600; margin: 0 0 4px; }
.page p { margin: 0; }
h2, h3 { margin: 0; }

/* Label column + control, shared by every field (also inside MySQL connections) so all inputs line up. */
.field { display: grid; grid-template-columns: 140px minmax(0, 1fr); align-items: center; gap: 4px 12px; margin: 8px 0; }
.field > label:first-child, .field > .label { color: var(--vscode-foreground); }
.field .hint { grid-column: 2; font-size: .92em; }
.inline { display: flex; align-items: center; gap: 12px; }
.inline input:first-child { flex: 1; min-width: 0; }
.inline .port { width: 90px; flex: none; }
.inline label { flex: none; display: flex; align-items: center; gap: 8px; }
.inline span { min-width: 0; overflow-wrap: anywhere; }
label.check { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
input[type=text], input[type=password], input[type=number], select { width: 100%; min-height: 26px; }
input[type=checkbox] { margin: 0; accent-color: var(--vscode-focusBorder); }
button:focus-visible, input[type=checkbox]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button.link { background: none; color: var(--vscode-textLink-foreground); padding: 4px 6px; }
button.link:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-textLink-activeForeground); }

.general { margin: 14px 0 6px; max-width: 600px; }
/* Server left, Database right; they stack when the panel is too narrow for two readable columns. */
.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: 18px; align-items: start; margin: 18px 0; }
.columns > .block { margin: 0; }

/* Server and Database: two clearly separate blocks with their own header band. */
.block { border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); border-radius: 6px; margin: 18px 0; }
.blockHead { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px;
	background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
	border-bottom: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); border-radius: 6px 6px 0 0; }
.blockHead > div { flex: 1; min-width: 0; }
.blockHead h2 { font-size: 1.15em; font-weight: 600; line-height: 20px; }
.blockHead p { margin: 2px 0 0; }
.blockHead .check { margin: 1px 0 0; white-space: nowrap; }
.icon { width: 20px; height: 20px; flex: none; fill: none; stroke: var(--vscode-icon-foreground, currentColor); stroke-width: 1.1; }
.icon .dot { fill: var(--vscode-icon-foreground, currentColor); stroke: none; }
.blockBody { padding: 4px 14px 12px; }
.group + .group { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.group h3 { font-size: 1em; font-weight: 600; margin: 8px 0 2px; }
.off { padding: 10px 14px; margin: 0; }

/* MySQL connections: a divided list inside the Database block (no nested cards). */
#mysqlList { counter-reset: conn; }
.conn { counter-increment: conn; padding: 10px 0 6px; }
.conn + .conn { border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.connHead { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.connHead .num { font-weight: 600; }
.connHead .num::before { content: 'Connessione ' counter(conn); }
#mysqlEmpty, #tunnelNote { margin: 10px 0; }
.addRow { margin-top: 6px; }

.actions { position: sticky; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 0 14px;
	background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); }
.actions .note { flex: 1 1 260px; margin: 0; font-size: .92em; }
#status { flex-basis: 100%; white-space: pre-wrap; margin: 0; }
#status:empty { display: none; }
.hidden { display: none !important; }

@media (max-width: 560px) {
	.columns { grid-template-columns: minmax(0, 1fr); }
	.field, .connHead { grid-template-columns: minmax(0, 1fr); }
	.field .hint { grid-column: 1; }
	.connHead .mRemove { justify-self: start; }
}`;
	const body = `
<header class="page">
	<h1 id="title">Nuovo spazio</h1>
	<p class="muted">Uno spazio riunisce l'accesso a un server (file, terminale, telemetria) e i suoi database MySQL.</p>
</header>
<form id="f" autocomplete="off">
<div class="general">
	<div class="field"><label for="name">Nome</label><input type="text" id="name" required></div>
	<div class="field"><label for="group">Cartella</label><input type="text" id="group" list="groups" placeholder="Nessuna: scegline una o scrivi un nome nuovo"></div>
	<datalist id="groups"></datalist>
</div>

<div class="columns">
<section class="block" aria-labelledby="serverTitle">
	<div class="blockHead"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><circle cx="4.75" cy="4.75" r=".6" class="dot"/><circle cx="4.75" cy="11.25" r=".6" class="dot"/></svg>
		<div><h2 id="serverTitle">Server</h2><p class="muted">Accesso ai file via SFTP o FTP. Con SFTP anche terminale, telemetria e tunnel per i database.</p></div>
		<label class="check"><input type="checkbox" id="filesOn" checked> Attivo</label>
	</div>
	<div id="filesBox" class="blockBody">
		<div class="group">
			<h3>Connessione</h3>
			<div class="field"><label for="protocol">Protocollo</label><select id="protocol"><option value="sftp">SFTP (SSH)</option><option value="ftp">FTP</option></select></div>
			<div class="field"><label for="host">Host</label><div class="inline"><input type="text" id="host" placeholder="es. server.esempio.it"><label for="port">Porta</label><input type="number" id="port" class="port" value="22"></div></div>
			<div class="field"><label for="user">Utente</label><input type="text" id="user"></div>
		</div>
		<div class="group">
			<h3>Autenticazione</h3>
			<div class="field sftpOnly"><label for="auth">Metodo</label><select id="auth"><option value="password">Password</option><option value="key">Chiave privata</option></select></div>
			<div class="field pwOnly"><label for="filesPassword">Password</label><input type="password" id="filesPassword"></div>
			<div class="field keyOnly"><span class="label">Chiave privata</span><div class="inline"><button type="button" class="secondary" id="pickKey">Scegli file chiave...</button><span id="keyName" class="muted"></span></div></div>
			<div class="field keyOnly"><label for="passphrase">Passphrase</label><input type="password" id="passphrase" placeholder="Solo se la chiave è protetta"></div>
		</div>
		<div class="group">
			<h3>Opzioni</h3>
			<div class="field"><label for="rootPath">Root path</label><input type="text" id="rootPath" value="/" placeholder="/var/www/html"></div>
			<div class="field ftpOnly"><span></span><label class="check"><input type="checkbox" id="ftps"> FTPS (TLS esplicito)</label></div>
			<div class="field ftpOnly ftpsOnly"><span></span><label class="check"><input type="checkbox" id="ftpsInsecure"> Accetta certificato non valido (self-signed o intestato al provider)</label></div>
			<div class="field"><span></span><label class="check"><input type="checkbox" id="showHidden"> Mostra file nascosti</label></div>
		</div>
	</div>
	<p id="filesOff" class="off muted hidden">Nessun accesso al server: lo spazio userà solo connessioni MySQL dirette.</p>
</section>

<section class="block" id="mysqlBox" aria-labelledby="dbTitle">
	<div class="blockHead"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.75" rx="5.5" ry="2"/><path d="M2.5 3.75v8.5c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-8.5"/><path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2"/></svg>
		<div><h2 id="dbTitle">Database MySQL</h2><p class="muted">Una o più connessioni. Col tunnel SSH il database è raggiunto passando dal server qui sopra.</p></div>
	</div>
	<div class="blockBody">
		<div id="mysqlList"></div>
		<p id="mysqlEmpty" class="muted">Nessuna connessione: aggiungine una se lo spazio usa un database.</p>
		<p id="tunnelNote" class="muted hidden">Il tunnel SSH è disponibile solo con accesso al server via SFTP: le connessioni qui sotto sono dirette.</p>
		<div class="addRow"><button type="button" class="link" id="addMysql">+ Aggiungi connessione MySQL</button></div>
	</div>
</section>
</div>

<template id="mysqlTpl"><div class="conn">
	<div class="connHead"><span class="num"></span><input type="text" class="mName" aria-label="Nome connessione" placeholder="Nome (opzionale, es. produzione)">
		<button type="button" class="link mRemove">Rimuovi</button></div>
	<div class="field sftpOnly"><span></span><label class="check"><input type="checkbox" class="mViaSsh" checked> Tramite tunnel SSH del server</label></div>
	<div class="field"><span class="label">Host</span><div class="inline"><input type="text" class="mHost" aria-label="Host MySQL" value="127.0.0.1"><label>Porta <input type="number" class="mPort port" value="3306"></label></div>
		<span class="hint muted tunnelHint">Indirizzo visto dal server: di solito 127.0.0.1</span></div>
	<div class="field"><span class="label">Utente</span><input type="text" class="mUser" aria-label="Utente MySQL"></div>
	<div class="field"><span class="label">Password</span><input type="password" class="mPassword" aria-label="Password MySQL"></div>
	<div class="field"><span class="label">Database</span><input type="text" class="mDatabase" aria-label="Database predefinito" placeholder="Opzionale: mostrato per primo"></div>
</div></template>

<div class="actions">
	<button type="submit">Salva</button><button type="button" class="secondary" id="test">Test connessione</button>
	<p class="note muted">Password e chiave sono cifrate con la superpassword. In modifica, i campi segreti vuoti restano invariati.</p>
	<div id="status" role="status"></div>
</div>
</form>`;
	const script = `
const $ = id => document.getElementById(id);
const status = (ok, text) => { $('status').textContent = text; $('status').className = ok ? '' : 'error'; };
let portTouched = false;
$('port').addEventListener('input', () => portTouched = true);

function sync() {
	const sftp = $('protocol').value === 'sftp', key = $('auth').value === 'key';
	$('filesBox').classList.toggle('hidden', !$('filesOn').checked);
	$('filesOff').classList.toggle('hidden', $('filesOn').checked);
	const sftpFiles = sftp && $('filesOn').checked;
	document.querySelectorAll('.sftpOnly').forEach(e => e.classList.toggle('hidden', e.closest('#mysqlBox') ? !sftpFiles : !sftp));
	// The hint about 127.0.0.1 only makes sense when that connection really goes through the tunnel.
	document.querySelectorAll('#mysqlList .conn').forEach(c => c.querySelector('.tunnelHint').classList.toggle('hidden', !(sftpFiles && c.querySelector('.mViaSsh').checked)));
	$('tunnelNote').classList.toggle('hidden', sftpFiles || !$('mysqlList').children.length);
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
	q('mViaSsh').addEventListener('change', sync);
	q('mRemove').addEventListener('click', () => {
		// Keep keyboard focus in the section instead of losing it with the removed button.
		const next = card.nextElementSibling ?? card.previousElementSibling;
		card.remove();
		sync();
		(next?.querySelector('.mName') ?? $('addMysql')).focus();
	});
	$('mysqlList').appendChild(card);
	sync();
	return card;
}
$('addMysql').addEventListener('click', () => addMysql().querySelector('.mName').focus());

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
