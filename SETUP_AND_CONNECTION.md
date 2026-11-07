# HouseLedger integration — Mac PostgreSQL + NestJS + Next.js

## What changed

- All frontend business data is read/written through NestJS `/api/v1` endpoints. No `demo-store.tsx`, `localStorage` business records or hardcoded dashboard financial totals remain in the delivered frontend.
- Existing migration files `001`–`004` are retained. Migration `005_identity_and_mobile_sessions.sql` adds optional admin usernames, manager NIDs, unique constraints and separate manager-app bearer sessions.
- Admin login uses username **or** Bangladesh mobile number plus password. Credentials are seeded once from backend `.env` by `npm run admin:seed`. Passwords are Argon2 hashes in the database.
- New manager form: full name, mobile number, NID (10/13/17 digits) and an app password of exactly 8 numeric digits. House selection is not required; assign houses later through the House detail page.
- Managers sign into `POST /api/v1/auth/app/login` with phone/password. App sessions are **not** admin web sessions and cannot call admin-only controllers. `GET /api/v1/auth/app/me` returns their authorized house assignments; `POST /api/v1/auth/app/logout` revokes the bearer token. Domain-specific manager app endpoints remain future work and must enforce house-level authorization.
- Optional demo seeder inserts *real, reconciled* database data (3 houses, 24 rooms, 3 managers, 3 residents, 6 bills, 4 payments, 3 tariffs, meter installation/readings). Visible money totals come from those real bill and payment rows, **not** the original prototype's artificially inflated aggregate totals. All demo identities are fictitious.

## Prerequisites

- Node.js version **22.22.3 or newer** (some locked NestJS 12 tooling requires it). Verify `node -v`.
- PostgreSQL on your Mac, running on `127.0.0.1:5432`.
- Access to both extracted project directories and npm registry for installing dependencies.

## Local PostgreSQL setup (skip if role/database already exist)

Check `psql --version` and `pg_isready -h 127.0.0.1 -p 5432`. Use the Mac PostgreSQL superuser:

```bash
psql -d postgres
```

```sql
CREATE ROLE houseledger LOGIN;
\password houseledger
CREATE DATABASE houseledger OWNER houseledger;
\q
```

If the role/database already exist, do not repeat CREATE commands. Check your real credentials via `psql -h 127.0.0.1 -U houseledger -d houseledger`.

## Backend

In the **backend** directory:

```bash
npm ci
cp .env.example .env
```

If a previous zip extraction omitted hidden files, create `.env` manually with these names:

```dotenv
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://houseledger:REPLACE_WITH_URL_ENCODED_PASSWORD@127.0.0.1:5432/houseledger
DB_POOL_SIZE=10
FRONTEND_ORIGINS=http://localhost:3000
ADMIN_NAME=Your Admin Name
ADMIN_USERNAME=admin
ADMIN_PHONE=017XXXXXXXX
ADMIN_PASSWORD=REPLACE_WITH_STRONG_PASSWORD_AT_LEAST_12_CHARS
ORGANIZATION_NAME=HouseLedger
DEMO_MANAGER_PASSWORD=
OBSERVE_APP_KEY=
OBSERVE_APP_SECRET=
```

`ADMIN_PHONE` must be a valid Bangladesh mobile number (`01` then 9 more digits). `ADMIN_USERNAME` contains 3–40 letters, numbers, `.`, `_` or `-` and begins with a letter. URL-encode reserved characters in `DATABASE_URL`. Never commit `.env`.

```bash
npm run db:migrate
npm run admin:seed
npm run start:dev
```

`admin:seed` is safe to rerun: it **does not reset existing administrator passwords**. If the prior version of the application created the same admin phone without a username, it will attach the configured username. An existing admin must continue using their existing password. If you explicitly want to replace the existing administrator password with `ADMIN_PASSWORD` from `.env`, use the guarded reset below. It matches `ADMIN_PHONE`, writes an audit event and revokes previous admin sessions:

```bash
ADMIN_RESET_CONFIRM=RESET_MY_ADMIN_PASSWORD npm run admin:reset-password
```

Do **not** run this in deployment automation. It intentionally changes login credentials.

Check `http://localhost:4000/api/v1/health` and `http://localhost:4000/api/docs`.

## Seed original prototype examples into PostgreSQL (optional)

**Only on an otherwise empty development workspace containing its admin.** This command refuses production or any populated workspace. Existing data is never deleted, reset or replaced.

```bash
npm run db:seed:demo
```

Run it again to confirm idempotency: it prints "already seeded" and makes no changes. The script matches the admin using `ADMIN_PHONE`. It uses synthetic manager phones/NIDs and the originally supplied sample names, addresses, room labels, residents, amounts and meter readings. Set `DEMO_MANAGER_PASSWORD` to exactly 8 numeric digits **before** seeding to enable app login for the three sample managers, or leave it blank and set their passwords individually in the admin UI later.

There are only 3 actual tenancy records and 6 actual billing records in the original supplied prototype. Its `24 rooms / 20 occupied`, `BDT 160,000` and `BDT 18,000` aggregate fields were visual placeholders without corresponding records. The real seeded dashboard correctly reports 24 rooms, 3 occupied rooms, 3 rent bills and 3 electricity bills; it does not invent the other 17 residents/bills.

## Frontend

In a **separate terminal** inside the **frontend** directory:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

`frontend/.env.local` contains only the server-side API origin:

```dotenv
API_ORIGIN=http://127.0.0.1:4000
```

Open `http://localhost:3000`. Log in with `ADMIN_USERNAME` (or `ADMIN_PHONE`) and the password seeded during account creation. The frontend proxies `/api/v1` requests to NestJS; it does not connect directly to PostgreSQL and must never receive `DATABASE_URL`.

If the browser still shows "Demo workspace" or "Reset demo data", you are running the **old demo frontend**. Replace it with the delivered **HouseLedger_Frontend_Connected.zip**, remove an old `.next` build (`rm -rf .next`) and restart `npm run dev`.

## Manager creation

1. Sign in as admin.
2. Open Managers, enter **Full name**, **Mobile number**, **NID number** and **App password**.
3. Save. `POST /api/v1/managers` persists the identity with an Argon2 password hash; the password is never returned in JSON.
4. Manage house assignments separately on a house detail page. Unassigned managers may authenticate in the app but receive zero assigned houses.
5. Edit a manager to update NID or reset app password. Leaving the new password blank keeps the current password. Changing identity, password or active status invalidates existing app sessions.

## App authentication contract (for future mobile integration)

```http
POST /api/v1/auth/app/login
Content-Type: application/json

{"phone":"017XXXXXXXX","password":"MANAGER_APP_PASSWORD"}
```

Successful response includes `{ "token": "...", "expiresInSeconds": 2592000, "user": { "id": "...", "role": "MANAGER" } }`. Use `Authorization: Bearer <token>` for `GET /api/v1/auth/app/me` and `POST /api/v1/auth/app/logout`. Store the bearer token only in the operating system's secure credential storage; do not embed it in URLs or browser `localStorage`.

These are only foundational identity endpoints. Any future manager room, resident, rent or electricity APIs must use **server-side scoped authorization** against current `manager_assignments`, not a house ID supplied by the client.

## Verify actual database persistence

```bash
psql -h 127.0.0.1 -U houseledger -d houseledger -c 'SELECT name FROM schema_migrations ORDER BY name;'
psql -h 127.0.0.1 -U houseledger -d houseledger -c 'SELECT name FROM houses;'
psql -h 127.0.0.1 -U houseledger -d houseledger -c "SELECT role,count(*) FROM users GROUP BY role ORDER BY role;"
psql -h 127.0.0.1 -U houseledger -d houseledger -c "SELECT type,count(*),sum(amount_minor),sum(paid_minor) FROM bills WHERE lifecycle='ISSUED' GROUP BY type;"
```

Check persistence by creating a new manager or house through the frontend, refreshing the page and checking PostgreSQL. Test that manager login with the correct password succeeds, incorrect password fails, app tokens cannot access `/houses` admin API, and signing out revokes mobile access.

## Validation

```bash
# backend
npm run build
npm test

# frontend
npm run typecheck
npm run lint
npm run build
```

The backend integration test was updated to expect migration 005, require manager NID/password, exercise hashed password storage, username admin login and manager app authentication. Run it on your Mac after dependencies are available. For production, do not run demo seeding; back up the database before new migrations. Configure TLS, secret management, hosted PostgreSQL backups, application logs and automated tests before deployment.
