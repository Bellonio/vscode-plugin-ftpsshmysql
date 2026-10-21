import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const args = process.argv.slice(2);
const production = args.includes('--production');

if (args.includes('--test')) {
	// Test bundle: one file per test, without vscode (pure modules only).
	await esbuild.build({
		entryPoints: readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`),
		outdir: 'out/test',
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		external: ['vscode'],
		logLevel: 'warning',
	});
} else {
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		// cpu-features and sshcrypto are optional native ssh2 add-ons: ssh2 falls back to pure JS.
		external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
		sourcemap: !production,
		minify: production,
		logLevel: 'info',
	});
	if (args.includes('--watch')) await ctx.watch();
	else { await ctx.rebuild(); await ctx.dispose(); }
}
