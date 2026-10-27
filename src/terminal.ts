import * as vscode from 'vscode';
import { StringDecoder } from 'node:string_decoder';
import type { ClientChannel } from 'ssh2';
import { Session } from './session';
import { openShell, shQuote } from './remote/sshClient';

/** Native VSCode terminal over a shell channel of the space's SSH connection (no new login). */
export function openTerminal(session: Session, onInput: () => void, cwd?: string) {
	const write = new vscode.EventEmitter<string>();
	const close = new vscode.EventEmitter<number | void>();
	let stream: ClientChannel | undefined;
	const dir = cwd ?? session.space.files?.rootPath;

	const pty: vscode.Pseudoterminal = {
		onDidWrite: write.event,
		onDidClose: close.event,
		async open(dim) {
			try {
				stream = await openShell(await session.getSsh(), dim?.columns ?? 120, dim?.rows ?? 30);
			} catch (e: any) {
				write.fire(`\r\n\x1b[31mConnessione non riuscita: ${e?.message ?? e}\x1b[0m\r\n`);
				return;
			}
			const decoder = new StringDecoder('utf8'); // keeps multi-byte chars split across chunks intact
			stream.on('data', (d: Buffer) => write.fire(decoder.write(d)));
			stream.stderr.on('data', (d: Buffer) => write.fire(d.toString('utf8')));
			stream.on('close', () => close.fire());
			if (dir && dir !== '/') stream.write(`cd ${shQuote(dir)}\n`);
		},
		close() {
			stream?.end();
		},
		handleInput(data) {
			onInput();
			stream?.write(data);
		},
		setDimensions(dim) {
			stream?.setWindow(dim.rows, dim.columns, 0, 0);
		},
	};
	vscode.window.createTerminal({ name: `SSH: ${session.space.name}`, pty, iconPath: new vscode.ThemeIcon('remote') }).show();
}
