// Master-password crypto: scrypt key derivation + AES-256-GCM. Pure module (no vscode import).
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

export interface VaultMeta {
	salt: string; // base64
	N: number;
	r: number;
	p: number;
	/** VERIFIER_TEXT encrypted with the derived key: detects a wrong password locally. */
	verifier: string;
}

const VERIFIER_TEXT = 'wsm-ok';
const DEFAULTS = { N: 2 ** 15, r: 8, p: 1 };

export function deriveKey(password: string, meta: Pick<VaultMeta, 'salt' | 'N' | 'r' | 'p'>): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scrypt(password.normalize('NFC'), Buffer.from(meta.salt, 'base64'), 32,
			{ N: meta.N, r: meta.r, p: meta.p, maxmem: 256 * meta.N * meta.r },
			(err, key) => (err ? reject(err) : resolve(key))));
}

/** Format: "v1:" + base64(iv[12] | tag[16] | ciphertext). */
export function encrypt(key: Buffer, plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Throws if the key is wrong or the data was tampered with. */
export function decrypt(key: Buffer, blob: string): string {
	if (!blob.startsWith('v1:')) throw new Error('Formato cifrato sconosciuto');
	const raw = Buffer.from(blob.slice(3), 'base64');
	const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	decipher.setAuthTag(raw.subarray(12, 28));
	return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export async function createMeta(password: string): Promise<{ meta: VaultMeta; key: Buffer }> {
	const base = { salt: randomBytes(16).toString('base64'), ...DEFAULTS };
	const key = await deriveKey(password, base);
	return { meta: { ...base, verifier: encrypt(key, VERIFIER_TEXT) }, key };
}

/** Returns the key if the password matches the vault, otherwise undefined. */
export async function unlock(password: string, meta: VaultMeta): Promise<Buffer | undefined> {
	const key = await deriveKey(password, meta);
	try {
		return decrypt(key, meta.verifier) === VERIFIER_TEXT ? key : undefined;
	} catch {
		return undefined;
	}
}

export function encryptJson(key: Buffer, value: object): string {
	return encrypt(key, JSON.stringify(value));
}

export function decryptJson<T>(key: Buffer, blob: string): T {
	return (blob ? JSON.parse(decrypt(key, blob)) : {}) as T;
}
