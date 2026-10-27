# Product

## Register

product

## Users
Developers and sysadmins who manage many client web spaces (shared hosting, VPS) from VS Code, on Windows and Ubuntu. Daily use: configure a space quickly, connect, browse/edit files, open an SSH terminal, run MySQL queries. They know what SFTP, FTPS, SSH tunnels and MySQL users are.

## Product Purpose
WebSpace Manager puts the files (SFTP/FTP), terminal, telemetry and MySQL databases of each web space in the VS Code sidebar, with credentials encrypted by a master password. Success: setting up a new space takes under a minute, and nothing ever connects (or risks a fail2ban ban) unless the user explicitly asks.

## Brand Personality
Native, sober, precise. It should feel like a built-in part of VS Code: the user's theme, system colors, dense but readable layouts. Italian UI copy, short and direct.

## Anti-references
- Web-app styling inside VS Code: custom brand colors, gradients, rounded "SaaS" cards, hero headings.
- Decorative motion or transitions.
- Wizards and step-by-step flows for things a single form handles.

## Design Principles
- Look native: only VS Code theme variables, so every theme (light, dark, high contrast) works without extra effort.
- Structure over decoration: hierarchy comes from grouping, headings and spacing, not ornaments.
- Expert speed: every field visible and editable at once; sensible defaults; no extra clicks.
- Explicit safety: say clearly what will connect, what is encrypted, what is unchanged.

## Accessibility & Inclusion
- WCAG AA contrast through VS Code theme variables; must work in light, dark and high-contrast themes.
- Fully keyboard-operable: logical focus order, no mouse-only actions, visible focus.
- No animations or transitions.
