# Admin Dashboard

License & activation management panel for the Motard Fabrics ERP.

Built with React 19, Vite, React Router and Tailwind CSS 4.

## Local wiring (ME-main)

| Service | URL |
|---------|-----|
| Admin dashboard | http://127.0.0.1:5174 |
| License Server | http://127.0.0.1:8081 (`LICENSE_SERVER_MODE=server`) |
| ERP API | http://127.0.0.1:8080 |

Dev dashboard leaves `VITE_LICENSE_SERVER_URL` empty; Vite proxies `/license-admin` and `/v1` → License Server (see `.env.local`).

```bash
# 1) Postgres up + migrations (backend/)
# 2) License Server
cd backend && npm run license-server

# 3) Dashboard
cd admin-dashboard && npm run dev
```

Create licenses in the dashboard, then activate/link them from the ERP app on :5173 / Desktop using the issued key.

### Link flow (local)

1. Open http://127.0.0.1:5174 — loopback opens without login (`LICENSE_ADMIN_OPEN_LOOPBACK=1`).
2. Click **إصدار ترخيص جديد** → pick edition `textile` / plan `premium` (or as needed) → copy the key.
3. Open http://127.0.0.1:5173 → setup wizard → paste the key on the activation step.
4. Admin and ERP must share the same Postgres (`localhost:5432/erp`) so the key exists for both License Server (:8081) and ERP API (:8080).

```bash
# After migrate on a fresh DB, apply canonical RLS once:
cd backend && node scripts/apply-rls.mjs
```

## Pages

- **Login** — dashboard authentication
- **Create License** — generate a license for a customer installation
- **License List** — browse, search and manage issued licenses

## Getting Started

```bash
cd admin-dashboard
npm install
npm run dev
```

## Scripts

| Script            | Description        |
| ----------------- | ------------------ |
| `npm run dev`     | Start dev server   |
| `npm run build`   | Type-check + build |
| `npm run lint`    | Oxlint             |
| `npm run preview` | Preview the build  |
