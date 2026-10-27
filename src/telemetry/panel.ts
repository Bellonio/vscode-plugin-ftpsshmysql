import * as vscode from 'vscode';
import { exec } from '../remote/sshClient';
import { Session, Sessions } from '../session';
import { page } from '../webview/html';
import {
	Caps, collectCmd, cpuPercent, CpuTimes, MYSQL_STATUS_SQL, mysqlStat, parseCpuStat, parseDf, parseLoadavg, parseMeminfo,
	parseProbe, parsePs, parseUptime, PROBE_CMD, splitSections,
} from './collect';

const CAPS_KEY = 'wsm.telemetry.caps';
const panels = new Map<string, vscode.WebviewPanel>();

/**
 * Server telemetry. Anti-ban rules: one probe exec decides what is readable (cached per space), each sample is a
 * single exec on the already-open SSH connection (no new logins), polling runs only while the panel is visible,
 * and the first failure stops it for good — no retry loops.
 */
export async function openTelemetry(sessions: Sessions, state: vscode.Memento, spaceId: string) {
	const existing = panels.get(spaceId);
	if (existing) return existing.reveal();
	const s = await sessions.open(spaceId);
	if (!s) return;

	const panel = vscode.window.createWebviewPanel('wsm.telemetry', `Telemetria: ${s.space.name}`, vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true });
	panels.set(spaceId, panel);
	panel.webview.html = html(panel.webview);
	const post = (m: object) => panel.webview.postMessage(m);

	let caps: Caps | undefined;
	let serverStopped = !s.isSftp;
	let mysqlStopped = !s.space.mysql?.length;
	let prevCpu: CpuTimes | undefined;
	let prevMysql: ReturnType<typeof mysqlStat>['snapshot'] | undefined;
	let timer: NodeJS.Timeout | undefined;
	let busy = false;

	const allCaps = () => state.get<Record<string, Caps>>(CAPS_KEY, {});

	async function probe(force: boolean) {
		if (!s!.isSftp) return post({ type: 'server', unavailable: 'Spazio senza SSH: la telemetria del server richiede un accesso SFTP/SSH.' });
		caps = force ? undefined : allCaps()[spaceId];
		if (!caps) {
			post({ type: 'server', info: 'Rilevamento delle metriche disponibili (un solo comando)...' });
			let ssh;
			try {
				ssh = await s!.getSsh();
			} catch (e: any) {
				serverStopped = true; // connection problem, not a capability answer: don't cache anything
				return post({ type: 'server', unavailable: `Connessione SSH non riuscita: ${e?.message ?? e}` });
			}
			try {
				caps = parseProbe((await exec(ssh, PROBE_CMD)).stdout);
			} catch {
				// The channel was refused: the account can't run commands. Remember it and never try on our own again.
				caps = { exec: false };
			}
			await state.update(CAPS_KEY, { ...allCaps(), [spaceId]: caps });
		}
		serverStopped = !caps.exec || !collectCmd(caps);
		if (!caps.exec) post({ type: 'server', unavailable: 'Il server non consente l\'esecuzione di comandi (account solo SFTP o shell limitata): telemetria del server non disponibile. Nessun altro tentativo verrà fatto.' });
		else if (!collectCmd(caps)) post({ type: 'server', unavailable: 'Il server non espone nessuna delle metriche supportate (/proc, df, ps).' });
		else post({ type: 'caps', caps });
	}

	async function sampleServer(session: Session) {
		const out = await exec(await session.getSsh(), collectCmd(caps!)!);
		const sec = splitSections(out.stdout);
		const cpuNow = parseCpuStat(sec.stat);
		const cpu = cpuPercent(prevCpu, cpuNow);
		prevCpu = cpuNow;
		post({
			type: 'sample', t: Date.now(), cpu,
			load: parseLoadavg(sec.loadavg), uptime: parseUptime(sec.uptime), mem: parseMeminfo(sec.meminfo),
			disks: caps!.df ? parseDf(sec.df) : undefined, procs: caps!.ps ? parsePs(sec.ps) : undefined,
			quota: caps!.quota ? sec.quota?.trim() : undefined,
		});
	}

	async function sampleMysql(session: Session) {
		// ponytail: status of the first connection only; a connection picker in the panel if spaces with several DB servers need it.
		const [rows] = await (await session.getMysql()).query<any[]>(MYSQL_STATUS_SQL);
		const r = mysqlStat(rows, prevMysql);
		prevMysql = r.snapshot;
		post({ type: 'mysql', stat: r.stat });
	}

	async function tick() {
		const session = sessions.get(spaceId);
		if (!session || busy || !panel.visible) return;
		busy = true;
		try {
			if (!serverStopped && caps?.exec) {
				try { await sampleServer(session); } catch (e: any) {
					serverStopped = true;
					post({ type: 'server', unavailable: `Raccolta interrotta: ${e?.message ?? e}. Premi "Riprova rilevamento" per ripartire.` });
				}
			}
			if (!mysqlStopped) {
				try { await sampleMysql(session); } catch (e: any) {
					mysqlStopped = true;
					post({ type: 'mysql', unavailable: `Stato MySQL non disponibile: ${e?.sqlMessage ?? e?.message ?? e}` });
				}
			}
		} finally {
			busy = false;
		}
	}

	function schedule() {
		clearInterval(timer);
		const sec = Math.max(5, vscode.workspace.getConfiguration('wsm').get<number>('telemetry.interval', 10));
		post({ type: 'interval', sec });
		timer = setInterval(tick, sec * 1000);
	}

	panel.webview.onDidReceiveMessage(async m => {
		if (m.type === 'ready') {
			if (!s.space.mysql?.length) post({ type: 'mysql', unavailable: 'Nessun database configurato per questo spazio.' });
			await probe(false);
			schedule();
			tick();
		} else if (m.type === 'reprobe') {
			prevCpu = undefined;
			mysqlStopped = !s.space.mysql?.length;
			await probe(true);
			tick();
		}
	});
	const cfg = vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('wsm.telemetry.interval') && schedule());
	const closed = sessions.onDidChange(id => id === spaceId && !sessions.get(id) && panel.dispose());
	panel.onDidChangeViewState(() => panel.visible && tick());
	panel.onDidDispose(() => {
		clearInterval(timer);
		cfg.dispose();
		closed.dispose();
		panels.delete(spaceId);
	});
}

function html(webview: vscode.Webview): string {
	return page(webview, 'Telemetria', `
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.card { border: 1px solid var(--vscode-panel-border); padding: 10px 14px; }
.card h3 { margin: 0 0 8px; font-size: 1em; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 4px 10px; align-items: center; }
.big { font-size: 1.6em; font-weight: 600; }
svg.spark { width: 100%; height: 40px; display: block; }
svg.spark polyline { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 1.5; }
.bar { height: 8px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
.bar > div { height: 100%; background: var(--vscode-charts-green); }
.bar > div.warn { background: var(--vscode-charts-orange); }
.bar > div.crit { background: var(--vscode-charts-red); }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
td.n, th.n { text-align: right; }
pre { white-space: pre-wrap; margin: 6px 0 0; }
.top { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }`,
	`<div class="top"><span id="state" class="muted"></span><button class="secondary" id="reprobe">Riprova rilevamento</button></div>
<div class="grid">
	<div class="card"><h3>CPU · RAM · Load</h3><div id="sys" class="muted">In attesa del primo campione...</div></div>
	<div class="card"><h3>Disco</h3><div id="disk" class="muted">—</div></div>
	<div class="card"><h3>Processi top (CPU)</h3><div id="procs" class="muted">—</div></div>
	<div class="card"><h3>MySQL</h3><div id="mysql" class="muted">—</div></div>
</div>`,
	`
const $ = id => document.getElementById(id);
const hist = { cpu: [], mem: [], load: [], qps: [] };
const MAX = 60;
let caps = {};
const push = (k, v) => { if (v === undefined || v === null || Number.isNaN(v)) return; hist[k].push(v); if (hist[k].length > MAX) hist[k].shift(); };
function spark(values, max) {
	if (values.length < 2) return '';
	const m = max ?? Math.max(...values, 1e-9);
	const pts = values.map((v, i) => (i / (MAX - 1) * 100).toFixed(1) + ',' + (38 - v / m * 36).toFixed(1)).join(' ');
	return '<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none"><polyline points="' + pts + '"/></svg>';
}
const bar = pct => '<div class="bar"><div class="' + (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '') + '" style="width:' + Math.min(100, pct) + '%"></div></div>';
const gb = kb => (kb / 1048576).toFixed(1) + ' GB';
const na = '<span class="muted">non disponibile sul server</span>';
function dur(s) { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'g ' : '') + h + 'h ' + m + 'm'; }
function bytes(n) { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }

$('reprobe').addEventListener('click', () => vscode.postMessage({ type: 'reprobe' }));

window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'interval') $('state').textContent = 'Aggiornamento ogni ' + m.sec + ' s (solo quando il pannello è visibile)';
	if (m.type === 'caps') { caps = m.caps; $('sys').textContent = 'In attesa del primo campione...'; }
	if (m.type === 'server') {
		const text = esc(m.unavailable ?? m.info);
		const cls = m.unavailable ? 'error' : 'muted';
		$('sys').innerHTML = '<span class="' + cls + '">' + text + '</span>';
		if (m.unavailable) { $('disk').innerHTML = '—'; $('procs').innerHTML = '—'; }
	}
	if (m.type === 'sample') {
		push('cpu', m.cpu);
		const memPct = m.mem ? (1 - m.mem.availKb / m.mem.totalKb) * 100 : undefined;
		push('mem', memPct);
		push('load', m.load?.[0]);
		$('sys').innerHTML = '<div class="kv">' +
			'<span>CPU</span><span>' + (caps.stat ? (m.cpu === undefined ? '<span class="muted">calcolo...</span>' : '<span class="big">' + m.cpu.toFixed(0) + '%</span>' + spark(hist.cpu, 100)) : na) + '</span>' +
			'<span>RAM</span><span>' + (m.mem ? memPct.toFixed(0) + '% di ' + gb(m.mem.totalKb) + bar(memPct) + spark(hist.mem, 100) : na) + '</span>' +
			(m.mem && m.mem.swapTotalKb ? '<span>Swap</span><span>' + gb(m.mem.swapTotalKb - m.mem.swapFreeKb) + ' / ' + gb(m.mem.swapTotalKb) + '</span>' : '') +
			'<span>Load</span><span>' + (m.load ? m.load.map(v => v.toFixed(2)).join(' · ') + spark(hist.load) : na) + '</span>' +
			'<span>Uptime</span><span>' + (m.uptime !== undefined ? dur(m.uptime) : na) + '</span></div>';
		$('disk').innerHTML = (m.disks ? (m.disks.length ? '<table>' + m.disks.map(d =>
			'<tr><td>' + esc(d.mount) + '</td><td class="n">' + gb(d.usedKb) + ' / ' + gb(d.sizeKb) + '</td><td style="width:35%">' + bar(d.pct) + '</td><td class="n">' + d.pct + '%</td></tr>').join('') + '</table>'
			: '<span class="muted">nessuna partizione</span>') : na) +
			(m.quota ? '<h3 style="margin-top:10px">Quota utente</h3><pre>' + esc(m.quota) + '</pre>' : '');
		$('procs').innerHTML = m.procs ? '<table><tr><th>PID</th><th>Comando</th><th class="n">CPU%</th><th class="n">MEM%</th></tr>' + m.procs.map(p =>
			'<tr><td>' + p.pid + '</td><td>' + esc(p.cmd) + '</td><td class="n">' + p.cpu.toFixed(1) + '</td><td class="n">' + p.mem.toFixed(1) + '</td></tr>').join('') + '</table>' : na;
	}
	if (m.type === 'mysql') {
		if (m.unavailable) { $('mysql').innerHTML = '<span class="muted">' + esc(m.unavailable) + '</span>'; return; }
		const s = m.stat;
		push('qps', s.qps);
		const r = v => v === undefined ? '<span class="muted">calcolo...</span>' : v;
		$('mysql').innerHTML = '<div class="kv">' +
			'<span>Connessioni</span><span>' + s.connected + ' (attive ' + s.running + ')</span>' +
			'<span>Query/s</span><span>' + r(s.qps?.toFixed(1)) + spark(hist.qps) + '</span>' +
			'<span>Traffico</span><span>' + r(s.rxps === undefined ? undefined : '↓ ' + bytes(s.rxps) + '/s · ↑ ' + bytes(s.txps) + '/s') + '</span>' +
			'<span>Uptime</span><span>' + dur(s.uptime) + '</span></div>';
	}
});
vscode.postMessage({ type: 'ready' });`);
}
