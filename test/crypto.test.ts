import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeta, decrypt, decryptJson, encrypt, encryptJson, unlock } from '../src/crypto';

test('roundtrip with correct password, rejection with wrong one', async () => {
	const { meta, key } = await createMeta('S3greta!');
	const blob = encryptJson(key, { filesPassword: 'p@ss', privateKey: '-----BEGIN-----' });
	assert.ok(!blob.includes('p@ss'));
	const key2 = await unlock('S3greta!', meta);
	assert.ok(key2);
	assert.deepEqual(decryptJson(key2!, blob), { filesPassword: 'p@ss', privateKey: '-----BEGIN-----' });
	assert.equal(await unlock('sbagliata', meta), undefined);
});

test('tampered ciphertext throws', async () => {
	const { key } = await createMeta('x');
	const blob = encrypt(key, 'hello');
	const raw = Buffer.from(blob.slice(3), 'base64');
	raw[raw.length - 1] ^= 1;
	assert.throws(() => decrypt(key, 'v1:' + raw.toString('base64')));
});

test('empty blob decrypts to empty object; same plaintext gives different blobs', async () => {
	const { key } = await createMeta('x');
	assert.deepEqual(decryptJson(key, ''), {});
	assert.notEqual(encrypt(key, 'a'), encrypt(key, 'a'));
});
