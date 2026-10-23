import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { History, HISTORY_MAX_SIZE, HISTORY_MAX_VERSIONS } from '../src/remote/history';

test('history: skips duplicates and big files, keeps the newest versions', async () => {
	const dir = join('.claude-tmp', `history-test-${process.pid}`);
	try {
		const h = new History(dir);
		const uri = 'wsm://space/www/index.php';
		assert.equal(await h.latest(uri), undefined);
		await h.add(uri, Buffer.from('a'));
		await h.add(uri, Buffer.from('a'));
		const first = (await h.latest(uri))!;
		assert.ok(first.endsWith('-index.php'));
		assert.equal((await fs.readdir(dirname(first))).length, 2); // uri.txt + 1 version
		await h.add(uri, new Uint8Array(HISTORY_MAX_SIZE));
		assert.equal(await h.latest(uri), first);
		await Promise.all([h.add(uri, Buffer.from('b')), h.add(uri, Buffer.from('b'))]); // concurrent reads: one version
		assert.equal((await fs.readdir(dirname(first))).length, 3);
		// same-millisecond writes must not overwrite each other
		for (let i = 0; i < HISTORY_MAX_VERSIONS + 5; i++) await h.add(uri, Buffer.from(`v${i}`));
		const names = await fs.readdir(dirname(first));
		assert.equal(names.length, HISTORY_MAX_VERSIONS + 1);
		assert.equal((await fs.readFile((await h.latest(uri))!)).toString(), `v${HISTORY_MAX_VERSIONS + 4}`);
		assert.equal(await fs.readFile(join(dirname(first), 'uri.txt'), 'utf8'), uri);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
