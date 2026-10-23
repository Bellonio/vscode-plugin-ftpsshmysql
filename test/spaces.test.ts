import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveSpace, sortSpaces, Space, stripSecrets } from '../src/spaces';

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
