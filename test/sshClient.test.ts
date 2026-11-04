import assert from 'node:assert/strict';
import { createServer, Server as TcpServer, Socket } from 'node:net';
import { test } from 'node:test';
import { Server, utils } from 'ssh2';
import { connectSsh } from '../src/remote/sshClient';
import { AuthError } from '../src/remote/remoteFs';

const hostKey = utils.generateKeyPairSync('ed25519').private;
const trust = async () => true;

/** Fake SSH server on loopback: records the auth methods tried, accepts only the password "good". */
async function withServer(offered: string[], run: (port: number, seen: string[]) => Promise<void>) {
	const seen: string[] = [];
	const server = new Server({ hostKeys: [hostKey] }, c => {
		c.on('error', () => undefined);
		c.on('authentication', (ctx: any) => {
			seen.push(ctx.method);
			if (ctx.method === 'password') return ctx.password === 'good' ? ctx.accept() : ctx.reject(offered);
			if (ctx.method === 'keyboard-interactive') {
				return ctx.prompt('Password:', (answers: string[]) => (answers[0] === 'good' ? ctx.accept() : ctx.reject(offered)));
			}
			ctx.reject(offered);
		});
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	try {
		await run((server.address() as { port: number }).port, seen);
	} finally {
		server.close();
	}
}

const params = (port: number, password: string) => ({ host: '127.0.0.1', port, user: 'u', password });

test('a wrong password is sent once per login, even when the server also offers keyboard-interactive', () =>
	withServer(['password', 'keyboard-interactive'], async (port, seen) => {
		await assert.rejects(connectSsh(params(port, 'bad'), trust), AuthError);
		assert.deepEqual(seen, ['none', 'password']);
	}));

test('falls back to keyboard-interactive only when the server does not offer password', () =>
	withServer(['keyboard-interactive'], async (port, seen) => {
		(await connectSsh(params(port, 'good'), trust)).end();
		assert.deepEqual(seen, ['none', 'keyboard-interactive']);
	}));

test('no password attempt at all when the server accepts neither method', () =>
	withServer(['publickey'], async (port, seen) => {
		await assert.rejects(connectSsh(params(port, 'good'), trust), AuthError);
		assert.deepEqual(seen, ['none']);
	}));

test('time spent on the host key prompt does not count towards the timeout', () =>
	withServer(['password'], async port => {
		const slowUser = () => new Promise<boolean>(r => setTimeout(() => r(true), 600));
		(await connectSsh(params(port, 'good'), slowUser, 300)).end();
	}));

test('a rekey of an established connection does not restart the timeout and kill it', () =>
	withServer(['password'], async port => {
		let checks = 0;
		const client = await connectSsh(params(port, 'good'), async () => { checks++; return true; }, 200);
		let closed = false;
		client.on('close', () => { closed = true; });
		(client as any)._protocol.rekey();
		await new Promise(r => setTimeout(r, 500));
		client.end();
		assert.equal(checks, 2); // the rekey really happened
		assert.equal(closed, false);
	}));

/** Plain TCP server for the cases where SSH never gets to talk. */
async function withTcp(onSocket: (s: Socket) => void, run: (port: number) => Promise<void>) {
	const sockets: Socket[] = [];
	const server: TcpServer = createServer(s => { sockets.push(s); s.on('error', () => undefined); onSocket(s); });
	await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	try {
		await run((server.address() as { port: number }).port);
	} finally {
		sockets.forEach(s => s.destroy());
		server.close();
	}
}

test('a server that never answers times out', () =>
	withTcp(() => undefined, port => assert.rejects(connectSsh(params(port, 'good'), trust, 300), /non ha risposto/)));

test('a server hanging up right after accepting (typical of a ban) rejects instead of hanging', () =>
	withTcp(s => s.destroy(), port => assert.rejects(connectSsh(params(port, 'good'), trust))));

test('a server hanging up after its banner rejects instead of hanging', () =>
	withTcp(s => { s.write('SSH-2.0-fake\r\n'); setTimeout(() => s.destroy(), 20); },
		port => assert.rejects(connectSsh(params(port, 'good'), trust, 2000), /chiuso la connessione/)));
