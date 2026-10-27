import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, filterKeys, groupNames, LEGACY_MYSQL_ID, migrateSecrets, moveSpace, mysqlKey, normalizeSpace, sortSpaces, Space, stripSecrets } from '../src/spaces';

const sp = (id: string, name: string, order: number, pinned = false): Space => ({ id, name, order, pinned, secrets: '' });
const ids = (l: Space[]) => l.map(s => s.id).join(',');

test('alpha sort is case-insensitive, numeric, pinned first', () => {
	const l = [sp('a', 'zeta', 0), sp('b', 'Alpha', 1), sp('c', 'cliente 10', 2), sp('d', 'cliente 2', 3), sp('e', 'zz', 4, true)];
	assert.equal(ids(sortSpaces(l, 'alpha')), 'e,b,d,c,a');
});

test('manual sort follows order, pinned first', () => {
	const l = [sp('a', 'a', 2), sp('b', 'b', 0), sp('c', 'c', 1, true)];
	assert.equal(ids(sortSpaces(l, 'manual')), 'c,b,a');
});

test('moveSpace stays inside its pinned group and renumbers', () => {
	const l = [sp('p', 'p', 0, true), sp('a', 'a', 1), sp('b', 'b', 2), sp('c', 'c', 3)];
	assert.equal(ids(moveSpace(l, 'a', 'up')), 'p,a,b,c'); // can't pass the pinned one
	assert.equal(ids(moveSpace(l, 'a', 'down')), 'p,b,a,c');
	assert.equal(ids(moveSpace(l, 'a', 'bottom')), 'p,b,c,a');
	assert.equal(ids(moveSpace(l, 'c', 'top')), 'p,c,a,b');
	assert.equal(ids(moveSpace(l, 'c', 'down')), 'p,a,b,c');
	assert.deepEqual(moveSpace(l, 'c', 'top').map(s => s.order), [0, 1, 2, 3]);
	assert.equal(l[1].order, 1, 'input not mutated');
});

test('moveSpace stays inside its folder, other folders keep their slots', () => {
	const g = (s: Space, group?: string) => ({ ...s, group });
	const l = [g(sp('a', 'a', 0), 'x'), g(sp('b', 'b', 1)), g(sp('c', 'c', 2), 'x'), g(sp('d', 'd', 3), 'x')];
	assert.equal(ids(moveSpace(l, 'c', 'up')), 'c,b,a,d'); // swaps with a, b (other folder) keeps its slot
	assert.equal(ids(moveSpace(l, 'a', 'bottom')), 'c,b,d,a');
	assert.equal(ids(moveSpace(l, 'b', 'up')), 'a,b,c,d'); // alone in the root: nowhere to go
	assert.deepEqual(groupNames([...l, g(sp('e', 'e', 4), 'Altri')]), ['Altri', 'x']);
});

test('normalizeSpace and migrateSecrets upgrade the single MySQL connection', () => {
	const old = { ...sp('a', 'a', 0), mysql: { host: 'h', port: 3306, user: 'u', viaSsh: false } } as unknown as Space;
	assert.deepEqual(normalizeSpace(old).mysql, [{ host: 'h', port: 3306, user: 'u', viaSsh: false, id: LEGACY_MYSQL_ID }]);
	const cur = { ...sp('b', 'b', 0), mysql: [{ id: 'x', host: 'h', port: 3306, user: 'u', viaSsh: false }] };
	assert.equal(normalizeSpace(cur), cur);
	assert.equal(normalizeSpace({ ...sp('c', 'c', 0), mysql: [] }).mysql, undefined);
	assert.deepEqual(migrateSecrets({ filesPassword: 'f', mysqlPassword: 'm' }), { filesPassword: 'f', [mysqlKey(LEGACY_MYSQL_ID)]: 'm' });
	const s = { [mysqlKey('x')]: 'm' };
	assert.equal(migrateSecrets(s), s);
});

test('stripSecrets removes each MySQL password, equal values share a group', () => {
	const r = stripSecrets([
		{ filesPassword: 'f', [mysqlKey('a')]: 'same', [mysqlKey('b')]: 'other' },
		{ [mysqlKey('c')]: 'same' },
	], ['mysqlPassword']);
	assert.deepEqual(r.map(x => x.kept), [{ filesPassword: 'f' }, {}]);
	assert.equal(r[0].missing[mysqlKey('a')], r[1].missing[mysqlKey('c')]);
	assert.notEqual(r[0].missing[mysqlKey('a')], r[0].missing[mysqlKey('b')]);
});

test('stripSecrets groups equal values and keeps the passphrase with its key', () => {
	const r = stripSecrets([
		{ privateKey: 'K', passphrase: 'P', mysqlPassword: 'm1' },
		{ privateKey: 'K', passphrase: 'P' },
		{ privateKey: 'K2' },
		{ filesPassword: 'f' },
	], ['privateKey', 'passphrase']);
	assert.deepEqual(r.map(x => x.kept), [{ mysqlPassword: 'm1' }, {}, {}, { filesPassword: 'f' }]);
	assert.equal(r[0].missing.privateKey, r[1].missing.privateKey);
	assert.equal(r[0].missing.passphrase, r[0].missing.privateKey);
	assert.notEqual(r[2].missing.privateKey, r[0].missing.privateKey);
	assert.equal(r[2].missing.passphrase, undefined);
	assert.deepEqual(r[3].missing, {});
});

test('applyFilter: OR inside host/type, AND across them, empty = all', () => {
	const files = (protocol: 'sftp' | 'ftp', host: string) => ({ protocol, host, port: 22, user: 'u', auth: 'password' as const, rootPath: '/' });
	const mysql = (host: string, viaSsh = false) => [{ id: host, host, port: 3306, user: 'u', viaSsh }];
	const l = [
		{ ...sp('a', 'a', 0), files: files('sftp', '1.1.1.1') },
		{ ...sp('b', 'b', 1), files: files('ftp', '1.1.1.1'), mysql: mysql('localhost') },
		{ ...sp('c', 'c', 2), files: files('ftp', '2.2.2.2') },
		{ ...sp('d', 'd', 3), mysql: mysql('3.3.3.3') },
	];
	assert.equal(ids(applyFilter(l, [])), 'a,b,c,d');
	assert.equal(ids(applyFilter(l, ['host:1.1.1.1', 'host:3.3.3.3'])), 'a,b,d');
	assert.equal(ids(applyFilter(l, ['type:ftp', 'type:mysql'])), 'b,c,d');
	assert.equal(ids(applyFilter(l, ['host:1.1.1.1', 'type:ftp'])), 'b');
	assert.deepEqual(filterKeys({ ...l[0], mysql: mysql('localhost', true) }), ['host:1.1.1.1', 'type:sftp', 'type:mysql']);
	assert.deepEqual(filterKeys({ ...l[3], mysql: [...mysql('3.3.3.3'), ...mysql('4.4.4.4'), ...mysql('localhost', true)] }),
		['host:3.3.3.3', 'host:4.4.4.4', 'type:mysql']);
});
