// Telemetry commands and parsers. Pure module (no vscode import).

export interface Caps {
	/** False when the server refuses command execution (SFTP-only accounts, jails). */
	exec: boolean;
	os?: string;
	loadavg?: boolean;
	uptime?: boolean;
	meminfo?: boolean;
	stat?: boolean;
	df?: boolean;
	ps?: boolean;
	quota?: boolean;
}

/** One exec, read-only and harmless: tells which metrics this server lets us read. */
export const PROBE_CMD = [
	'uname -s 2>/dev/null',
	'for f in loadavg uptime meminfo stat; do [ -r /proc/$f ] && echo "HAS $f"; done',
	'df -kP >/dev/null 2>&1 && echo "CMD df"',
	'ps -eo pid,comm,%cpu,%mem --sort=-%cpu >/dev/null 2>&1 && echo "CMD ps"',
	'command -v quota >/dev/null 2>&1 && echo "CMD quota"',
	'true',
].join('; ');

export function parseProbe(out: string): Caps {
	const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const has = (s: string) => lines.includes(s);
	return {
		exec: true,
		os: lines.find(l => !l.startsWith('HAS ') && !l.startsWith('CMD ')),
		loadavg: has('HAS loadavg'), uptime: has('HAS uptime'), meminfo: has('HAS meminfo'), stat: has('HAS stat'),
		df: has('CMD df'), ps: has('CMD ps'), quota: has('CMD quota'),
	};
}

/** A single command per sample, containing only the parts the probe found available. */
export function collectCmd(c: Caps): string | undefined {
	const parts: string[] = [];
	const sec = (name: string, cmd: string) => parts.push(`echo @@${name}`, cmd);
	if (c.loadavg) sec('loadavg', 'cat /proc/loadavg');
	if (c.uptime) sec('uptime', 'cat /proc/uptime');
	if (c.meminfo) sec('meminfo', 'cat /proc/meminfo');
	if (c.stat) sec('stat', 'head -n 1 /proc/stat');
	if (c.df) sec('df', 'df -kP 2>/dev/null');
	if (c.ps) sec('ps', 'ps -eo pid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -n 11');
	if (c.quota) sec('quota', 'quota -s 2>/dev/null');
	return parts.length ? parts.join('; ') : undefined;
}

export function splitSections(out: string): Record<string, string> {
	const res: Record<string, string> = {};
	let cur: string | undefined;
	for (const line of out.split(/\r?\n/)) {
		const m = /^@@(\w+)$/.exec(line.trim());
		if (m) { cur = m[1]; res[cur] = ''; }
		else if (cur) res[cur] += line + '\n';
	}
	return res;
}

export function parseLoadavg(s?: string): [number, number, number] | undefined {
	const n = s?.trim().split(/\s+/).slice(0, 3).map(Number);
	return n && n.length === 3 && n.every(Number.isFinite) ? (n as [number, number, number]) : undefined;
}

export function parseUptime(s?: string): number | undefined {
	const n = Number(s?.trim().split(/\s+/)[0]);
	return Number.isFinite(n) && s?.trim() ? n : undefined;
}

export interface Mem { totalKb: number; availKb: number; swapTotalKb: number; swapFreeKb: number }

export function parseMeminfo(s?: string): Mem | undefined {
	if (!s) return;
	const v: Record<string, number> = {};
	for (const m of s.matchAll(/^(\w+):\s+(\d+)/gm)) v[m[1]] = Number(m[2]);
	if (!v.MemTotal) return;
	// MemAvailable exists since Linux 3.14; older kernels: approximate with free + buffers + cache.
	const avail = v.MemAvailable ?? (v.MemFree ?? 0) + (v.Buffers ?? 0) + (v.Cached ?? 0);
	return { totalKb: v.MemTotal, availKb: avail, swapTotalKb: v.SwapTotal ?? 0, swapFreeKb: v.SwapFree ?? 0 };
}

export interface CpuTimes { idle: number; total: number }

export function parseCpuStat(s?: string): CpuTimes | undefined {
	const m = /^cpu\s+(.+)$/m.exec(s ?? '');
	if (!m) return;
	const n = m[1].trim().split(/\s+/).map(Number);
	if (n.length < 4 || !n.every(Number.isFinite)) return;
	// user nice system idle iowait irq softirq steal ...: idle time = idle + iowait.
	return { idle: n[3] + (n[4] ?? 0), total: n.slice(0, 8).reduce((a, b) => a + b, 0) };
}

export function cpuPercent(prev: CpuTimes | undefined, cur: CpuTimes | undefined): number | undefined {
	if (!prev || !cur) return;
	const dt = cur.total - prev.total;
	if (dt <= 0) return;
	return Math.max(0, Math.min(100, (1 - (cur.idle - prev.idle) / dt) * 100));
}

export interface Disk { fs: string; sizeKb: number; usedKb: number; availKb: number; pct: number; mount: string }

const PSEUDO_FS = /^(tmpfs|devtmpfs|udev|overlay|shm|none|squashfs|efivarfs)$/;

export function parseDf(s?: string): Disk[] {
	if (!s) return [];
	return s.split(/\r?\n/).slice(1).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 6)
		.map(p => ({ fs: p[0], sizeKb: +p[1], usedKb: +p[2], availKb: +p[3], pct: parseInt(p[4], 10), mount: p.slice(5).join(' ') }))
		.filter(d => Number.isFinite(d.sizeKb) && d.sizeKb > 0 && !PSEUDO_FS.test(d.fs) && !d.mount.startsWith('/snap/'));
}

export interface Proc { pid: number; cmd: string; cpu: number; mem: number }

export function parsePs(s?: string): Proc[] {
	if (!s) return [];
	return s.split(/\r?\n/).slice(1).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 4)
		.map(p => ({ pid: +p[0], cmd: p.slice(1, -2).join(' '), cpu: +p[p.length - 2], mem: +p[p.length - 1] }))
		.filter(p => Number.isFinite(p.pid));
}

export const MYSQL_STATUS_SQL =
	"SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Questions','Bytes_received','Bytes_sent','Uptime')";

export interface MysqlStat { connected: number; running: number; qps?: number; rxps?: number; txps?: number; uptime: number }

export function mysqlStat(rows: { Variable_name: string; Value: string }[], prev?: { t: number; v: Record<string, number> }, t = Date.now()) {
	const v = Object.fromEntries(rows.map(r => [r.Variable_name, Number(r.Value)]));
	const dt = prev ? (t - prev.t) / 1000 : 0;
	const rate = (k: string) => (prev && dt > 0 ? Math.max(0, (v[k] - prev.v[k]) / dt) : undefined);
	const stat: MysqlStat = {
		connected: v.Threads_connected, running: v.Threads_running, uptime: v.Uptime,
		qps: rate('Questions'), rxps: rate('Bytes_received'), txps: rate('Bytes_sent'),
	};
	return { stat, snapshot: { t, v } };
}
