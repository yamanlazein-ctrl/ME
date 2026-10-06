# ERP Desktop

Tauri 2 desktop shell for the Motard Fabrics ERP web app.

## Development

```bash
cd desktop
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

> Note: this is the packaged **desktop** build. It is fully self-contained: the
> UI is served by Tauri over its own asset protocol and the API is reached through
> a Windows named pipe (`\\.\pipe\motard-erp`), so the shipped app opens **no**
> HTTP port and needs **no** externally running backend or database server: the
> company data is one SQLite file, `%LOCALAPPDATA%\motard-erp\data\motard.db`
> (`motard-erp-dev` for debug builds), opened in-process by the backend
> (specs/001-desktop-sqlite-engine). Startup states, backups and restore:
> `docs/DISASTER-RECOVERY.md` and `specs/001-desktop-sqlite-engine/contracts/`.
>
> The `8080` backend and the `5173` Vite dev server are the **web / development**
> flow only (`npm run dev` at the repo root; the web/cloud backend keeps PostgreSQL)
> and are not part of how the desktop client runs.
