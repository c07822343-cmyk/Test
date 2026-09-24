# ApexWeb OS desktop app

A window onto the dashboard plus a tray / menu-bar icon that keeps ApexWeb running 24/7.

- **Starts when you log in** and stays in the tray when you close the window.
- **Keeps the services up**: runs `docker compose up -d` if the core is down and restarts it
  if it stops responding. Work is saved in Postgres, so nothing is lost across restarts.
- **Notifies you** when an approval is needed, a project finishes, or a project needs your input.
- **Tray icon colour**: green = running, amber = starting or no NVIDIA keys, red = not responding.
- **Tray menu**: Open ApexWeb, Open Obsidian vault, Open n8n, Start / Restart / Stop services,
  auto-restart and start-at-login toggles, logs folder.

## Install

Use the installer, which also installs Docker, Obsidian and Node, sets up `.env` and your vault:

- Windows: `powershell -ExecutionPolicy Bypass -File desktop\install\install-windows.ps1`
- macOS / Linux: `bash desktop/install/install.sh`

Manual: `cd desktop && npm install && npm start` (the app looks for the ApexWeb folder one level
up, or at `APEXWEB_HOME`). `npm run dist` builds a native installer (NSIS / DMG / AppImage).

Settings live in `config.json` in the app's data folder (tray → Open logs folder):
`repoDir`, `coreUrl`, `n8nUrl`, `manageServices`, `startAtLogin`.

The API token is read from the ApexWeb `.env` and passed to the dashboard in the URL fragment,
so it is never sent over the network or written to logs.
