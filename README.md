# Cirkla Factory OS — Inward Vehicle Inspection module

First module of Factory OS, built fresh (no prior repo/Supabase project existed).
Stack: Next.js/TypeScript frontend, FastAPI backend, Postgres (Supabase-compatible schema),
ports/adapters for OCR, storage and auth so Tesseract/local-storage/dev-auth can be swapped
for Google Vision-or-similar/Supabase Storage/Supabase Auth without touching business logic.

## Run it

Backend:
```
cd backend
pip install -r requirements.txt   # or see the packages installed in this session
# Postgres must be running with a database matching backend/.env's FACTORY_DATABASE_URL
psql -f migrations/0001_init.sql <connection...>
psql -f migrations/0002_inward_qc.sql <connection...>
psql -f migrations/0003_rm_fg_qr_storage.sql <connection...>
psql -f migrations/0004_vendors.sql <connection...>
psql -f migrations/0005_material_consumption.sql <connection...>
psql -f migrations/0006_vendor_country.sql <connection...>
psql -f migrations/0007_performance_indexes.sql <connection...>
uvicorn app.main:app --reload --port 8000
```

OCR (photo identifier extraction on Inward Vehicle Inspection) and COA
parsing (Inward QC) both need the real `tesseract` binary, and PDF-based
COA parsing also needs `poppler`. Linux's `tesseract-ocr` / `poppler-utils`
packages put both on PATH automatically. On Windows, install
[Tesseract-OCR](https://github.com/UB-Mannheim/tesseract/wiki) and
[poppler for Windows](https://github.com/oschwartz10612/poppler-windows/releases),
then either add both to your System PATH or set `FACTORY_TESSERACT_CMD` /
`FACTORY_POPPLER_PATH` in `backend/.env` (see `.env.example`) to their
install paths directly — no PATH edit needed. If OCR or COA parsing ever
silently "does nothing", check the backend console: both now log the exact
missing-binary error there instead of failing quietly.

Frontend:
```
cd frontend
npm install
npm run dev   # http://localhost:3000, redirects to /inward-vehicle-inspection
```

`frontend/.env.local` points at `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`.

## Switching to real Supabase

- `backend/.env`: set `FACTORY_DATABASE_URL` to the Supabase Postgres connection string,
  `FACTORY_STORAGE_PROVIDER=supabase` + `FACTORY_SUPABASE_URL` + `FACTORY_SUPABASE_SERVICE_KEY`,
  `FACTORY_AUTH_PROVIDER=supabase` + `FACTORY_SUPABASE_JWT_SECRET`.
- Run `migrations/0001_init.sql` against the Supabase project.
- No application code changes are required — adapters are selected purely by config
  (`app/adapters/{ocr,storage,auth}/factory.py`).
- The frontend's dev-user role switcher (`src/lib/session.ts`) should be replaced with a real
  Supabase Auth (Google OAuth) sign-in flow; `getAuthHeader()` is the only integration point.

## Dev / test users

Seeded in the migration: `r.fernandez@cirkla.com` (Admin — full permissions) and
`staff@cirkla.com` (Staff — view + fill_section only). Switch between them via the role
selector at the bottom of the sidebar; this simulates what Supabase Auth sessions will do later.
