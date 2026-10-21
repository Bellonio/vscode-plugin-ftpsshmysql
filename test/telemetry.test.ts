import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	collectCmd, cpuPercent, mysqlStat, parseCpuStat, parseDf, parseLoadavg, parseMeminfo, parseProbe, parsePs, parseUptime, splitSections,
} from '../src/telemetry/collect';

test('probe: full Linux server vs restricted one', () => {
	const full = parseProbe('Linux\nHAS loadavg\nHAS uptime\nHAS meminfo\nHAS stat\nCMD df\nCMD ps\n');
	assert.deepEqual(full, { exec: true, os: 'Linux', loadavg: true, uptime: true, meminfo: true, stat: true, df: true, ps: true, quota: false });
	const jail = parseProbe('');
	assert.equal(collectCmd(jail), undefined, 'nothing available -> no command at all');
	assert.equal(collectCmd({ exec: true, df: true }), 'echo @@df; df -kP 2>/dev/null');
});

test('sections and simple parsers', () => {
	const s = splitSections('@@loadavg\n0.52 0.58 0.59 1/389 12345\n@@uptime\n350735.47 234388.90\n');
	assert.deepEqual(parseLoadavg(s.loadavg), [0.52, 0.58, 0.59]);
	assert.equal(parseUptime(s.uptime), 350735.47);
	assert.equal(parseLoadavg(''), undefined);
	assert.equal(parseUptime(undefined), undefined);
});

test('meminfo with and without MemAvailable', () => {
	assert.deepEqual(parseMeminfo('MemTotal:  16000000 kB\nMemFree: 1000 kB\nMemAvailable:  8000000 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n'),
		{ totalKb: 16000000, availKb: 8000000, swapTotalKb: 2000, swapFreeKb: 500 });
	assert.equal(parseMeminfo('MemTotal: 100 kB\nMemFree: 10 kB\nBuffers: 5 kB\nCached: 20 kB\n')!.availKb, 35);
	assert.equal(parseMeminfo('garbage'), undefined);
});

test('cpu percent from two /proc/stat samples', () => {
	const a = parseCpuStat('cpu  100 0 100 800 0 0 0 0 0 0\n');
	const b = parseCpuStat('cpu  150 0 150 900 0 0 0 0 0 0\n');
	assert.equal(cpuPercent(a, b), 50);
	assert.equal(cpuPercent(undefined, b), undefined);
	assert.equal(cpuPercent(b, b), undefined);
});

test('df skips pseudo filesystems, keeps mount points with spaces', () => {
	const df = parseDf(`Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         41152736 20576368  18463232      53% /
tmpfs              1015452        0   1015452       0% /dev/shm
/dev/sdb1        103081248 51540624  46280984      53% /mnt/my disk
`);
	assert.equal(df.length, 2);
	assert.deepEqual(df[1], { fs: '/dev/sdb1', sizeKb: 103081248, usedKb: 51540624, availKb: 46280984, pct: 53, mount: '/mnt/my disk' });
});

test('ps top processes', () => {
	const ps = parsePs(`    PID COMMAND         %CPU %MEM
   1234 php-fpm: pool    12.5  3.1
     42 mysqld            4.0 10.2
`);
	assert.deepEqual(ps, [{ pid: 1234, cmd: 'php-fpm: pool', cpu: 12.5, mem: 3.1 }, { pid: 42, cmd: 'mysqld', cpu: 4, mem: 10.2 }]);
});

test('mysql status rates', () => {
	const rows = (q: number) => [
		{ Variable_name: 'Threads_connected', Value: '3' }, { Variable_name: 'Threads_running', Value: '1' },
		{ Variable_name: 'Questions', Value: String(q) }, { Variable_name: 'Bytes_received', Value: '0' },
		{ Variable_name: 'Bytes_sent', Value: '0' }, { Variable_name: 'Uptime', Value: '100' },
	];
	const first = mysqlStat(rows(1000), undefined, 0);
	assert.equal(first.stat.qps, undefined);
	const second = mysqlStat(rows(1500), first.snapshot, 10000);
	assert.equal(second.stat.qps, 50);
	assert.equal(second.stat.connected, 3);
});
