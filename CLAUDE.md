# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VSCode extension "WebSpace Manager": web spaces over SFTP/FTP(S) with file tree, SSH terminal, MySQL, server telemetry, and master-password-encrypted credentials. UI strings are in Italian. It must work on Windows and Ubuntu: runtime dependencies are pure JS only (`ssh2`, `basic-ftp`, `mysql2`), with no local shell commands.

## Commands
```
npm run build        # esbuild bundle -> dist/extension.js (F5 runs the Extension Development Host)
npm run watch
npm run typecheck    # tsc --noEmit (esbuild does not type-check)
npm test             # bundles test/*.test.ts to out/test/ and runs node --test
node esbuild.mjs --test && node --test out/test/crypto.test.js                  # single test file
node esbuild.mjs --test && node --test --test-name-pattern="moveSpace" "out/test/*.test.js"
npm run package      # typecheck + production build + vsce package -> .vsix
```
Tests only cover the modules without `vscode` (`spaces.ts`, `crypto.ts`, `telemetry/collect.ts`, `mysql/sqlgen.ts`, and `remote/sshClient.ts` against a fake SSH server on loopback). These must not import `vscode`, because the test bundle can't resolve it. Keep any new testable logic in vscode-free modules.

## Architecture
- **Data**: a `Space` (`spaces.ts`) groups optional `files` (sftp|ftp, rootPath) and a list of `mysql` connections (each with its own `id`, optionally `viaSsh`), plus an optional sidebar folder `group`.
  - Old spaces/exports with a single `mysql` object are upgraded on read by `normalizeSpace` (connection id `m`); `migrateSecrets` moves the old `mysqlPassword` to `mysqlPassword:m`.
  - Spaces are stored in `globalState` by `Store`.
  - Credentials are never stored in clear. They live in `space.secrets`, an AES-256-GCM blob (`crypto.ts`) whose key is derived from the master password with scrypt. MySQL passwords are keyed `mysqlPassword:<connId>`.
  - Vault meta (salt, KDF params, verifier) is in `globalState` under `wsm.vault.meta`.
- **Master password** (`vault.ts`):
  - It is asked on every connection of a space, by design, and is never cached.
  - A wrong password is detected locally through the verifier, before any server is contacted.
  - Export/import (`.wsm.json`) keeps the blobs encrypted. An import re-encrypts them with the local key.
- **Sessions** (`session.ts`): an unlocked space.
  - Decrypted secrets live only in memory, in `Session`, until disconnect. `Sessions.open()` prompts for the password; `Sessions.get()` never does.
  - SSH, SFTP and MySQL connections are lazy promises. Terminal, telemetry and the MySQL tunnel (`forwardOut`) share the single SSH client.
  - Dropped connections reconnect with the in-memory secrets.
  - After 8h without VS Code activity (focus, editor, tree, SSH terminal input → `Sessions.touch()`) every session is closed.
  - `Session.list()` holds the directory cache and dedupes in-flight requests. The tree and the search read only from it, so refreshing the view does not re-list folders on the server. Call `invalidate(dir)` after mutations; it is recursive.
- **Remote FS**: `remote/remoteFs.ts` defines `RemoteFs`, implemented by `SftpFs` and `FtpFs`.
  - Remote paths are always POSIX (`path.posix`).
  - `within(root, p)` enforces the root path.
  - `FtpFs` serializes every operation through a promise queue, because basic-ftp allows one command at a time.
  - Symlinks are deleted as links, never by recursing into their target.
- **Editors** (`remote/fsProvider.ts`):
  - Files open as `wsm://<spaceId>/<path>`.
  - Reads never log in (`Session.liveFs()`). Without a live connection they are served from `remote/snapshots.ts`: plain local copies in globalStorage, pruned when tabs close. This lets restored tabs work without a prompt.
  - Writes connect (prompting for the password) and check the remote mtime/size against the snapshot before overwriting.
  - VSCode re-stats an open document when its tab is shown and would reload it silently. While online, `stat` reports the snapshot for open documents whose remote file changed and, if not dirty, asks "Ricarica" once per remote version (dirty ones are left to `confirmOverwrite` on save); `reload()` re-reads on purpose.
  - Opening a file from the tree (`FileOps.open`) connects first. If the tab is already open, it is reverted so the file is re-read from the server, after a confirmation when it has unsaved changes.
  - Every online read also stores a version in `remote/history.ts`: plain files under 1 MB, at most 50 per file, no duplicates. The clock icon on a file node reveals that folder in the OS file manager.
- **Tree** (`tree.ts`): nodes are cached by id.
  - Child ids include a per-space nonce that changes at every activation and every disconnect. VSCode restores expanded state by id, so a stable id would make a restored "File" node connect by itself.
  - Spaces and folders have no `command`, and nothing does I/O except expanding "File"/"DB". A click must never connect.
  - In a space without MySQL, "File" starts expanded, so expanding the space connects. That is why the space item id carries the nonce too: spaces come back collapsed at activation and disconnect.
  - "Filtra" (`applyFilter()` in `spaces.ts`) is in memory only. It shows in the view description and in the `wsm.filtered` context key.
  - `DropController` accepts only external `text/uri-list` drops (upload). Tree nodes are not draggable, on purpose.
- **Ordering**: `wsm.sortMode` is `alpha` or `manual`; pinned spaces always come first. The `wsm.manualSort` context key gates the move commands and Alt+↑/↓. `moveSpace()` keeps a space inside its pinned group.
- **Telemetry** (`telemetry/`): anti-ban rules.
  - A single probe `exec` decides the capabilities, cached per space in `wsm.telemetry.caps`. If exec is refused, it never tries on its own again.
  - Each sample is one `exec` on the existing SSH connection, and only runs while the panel is visible.
  - The first error stops polling until "Riprova rilevamento".
- **Auth failures** are never retried automatically, on SSH or FTP. The aim is to avoid fail2ban bans.
  - A refused login is remembered by `Session` (`AuthError`): nothing logs in again until the session is closed (disconnect, or editing the space).
  - The password is sent once per login (`passwordAuth()` picks `password` or `keyboard-interactive`, never both).
  - A failed tree fetch is remembered per node (`SpacesTree.failed`): automatic refreshes don't repeat it, only "Aggiorna" or a disconnect do.
  - `Session.checkCredentials()` refuses to connect at all when the needed secret is missing.
- **SSH host keys**: trust on first use, with SHA256 fingerprints stored in `wsm.hostKeys`.
- **Webviews** (`webview/html.ts` `page()`): vanilla HTML/JS with a nonce-based CSP and VSCode theme variables.
  - The space form never receives the private key content or stored secrets. Empty secret fields mean "unchanged".

## Conventions
- **Context menus** are driven by `contextValue` strings. Examples: `group`, `space[:pinned][:connected]`, `filesRoot:<protocol>`, `folder:<protocol>`, `file:<protocol>`, `db`, `database`, `table`. `package.json` matches them with regexes, so keep the two in sync.
- **Commands** registered with the `cmd()` helper (`extension.ts`) get the node from the menu, or from the tree selection when run from a keybinding.
- **Intentional shortcuts** are marked with `ponytail:` comments.
