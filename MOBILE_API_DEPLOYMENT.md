# HouseLedger mobile API — additive Vercel update

This update **does not replace or change existing admin-web routes**. All existing `/api/v1/houses`, `/api/v1/rooms`, `/api/v1/residents`, `/api/v1/rent/...`, `/api/v1/electricity/...`, `/api/v1/auth/web/login`, and `/api/v1/auth/app/...` handlers, database service, app entrypoint, and Vercel configuration are preserved.

## Exactly what changed

- `src/app.module.ts`: adds one `MobileModule` import and one imports-array entry.
- New `src/mobile/{mobile.module,mobile.controller,mobile.service,mobile.guard}.ts` files.
- New additive migration `migrations/006_mobile_resident_profiles.sql` for optional resident profile email, without changing existing tables or their data.
- Updated `dist/mobile/*.js`, `dist/app.module.js` for teams deploying prebuilt output. Vercel builds should still run `npm run build` from TypeScript.

**No existing authentication/controller/business-service source was modified.** Admin web continues to authenticate using its existing cookie and CSRF flow. Mobile bearer tokens cannot call web Admin endpoints.

## Deployment order

1. Back up the production PostgreSQL database before deploying.
2. Ensure environment variables and connection details match the currently working Vercel backend (`DATABASE_URL`, `SUPABASE_DB_CA_CERT`, and any existing required secrets); leave current `FRONTEND_ORIGINS` unchanged.
3. Apply the **new migration once** from a trusted machine/CI runner with the same database credentials already used by the project:

   ```bash
   npm ci
   npm run db:migrate
   ```

   The migration runner tracks applied scripts. Do not run demo seeders against production.
4. Deploy this full backend project to **the existing Vercel project**, retaining all current environment variables and the existing database. For the source-build path:

   ```bash
   npm run build
   vercel --prod
   ```

   If you deploy via Git, commit/push to the already-connected production repository; Vercel should redeploy from the same project configuration. Do not create a second backend deployment unintentionally.
5. Check the previously working `GET /api/v1/health` endpoint and the admin website login/CRUD. Then test `POST /api/v1/mobile/auth/login` with a real Manager's phone/password. `GET /api/v1/mobile/bootstrap` must return only authorized data.

Migration **006 must be applied before mobile `/bootstrap` or profile requests**; otherwise those requests will fail because `mobile_resident_profiles` does not exist.

## Provisioning and authentication

- Admin accounts are created through the existing trusted backend installer and managed through the existing admin web.
- Manager accounts and house assignments are created/managed by the existing admin web, with the existing numeric 8-digit Manager credentials. There is no unauthorized public Manager sign-up endpoint.
- Managers can create and assign residents from the Flutter app. The backend generates a strong temporary password and returns it **only once** to the creating Manager, who must share it privately. Residents can then sign in with their assigned phone/password.
- Managers can reset a linked resident's password. This revokes that resident's existing mobile sessions.
- Web Admin, Manager and Resident users sign in from the Flutter app via `/api/v1/mobile/auth/login`. Their role comes from the database, not Flutter parameters. Admin mobile interface is **read-only**.
- Password recovery by SMS/OTP is deliberately not faked: it requires a real SMS provider and a verified reset protocol, which have not been enabled here. Instead the app directs users to their administrator/manager.

## Mobile endpoints (all prefixed `/api/v1/mobile`)

| Method | Route | Permission |
| --- | --- | --- |
| POST | `/auth/login` | Public, rate-limited |
| GET / POST | `/auth/me`, `/auth/logout` | Any signed-in mobile user |
| GET | `/bootstrap` | Role/house/resident-scoped database data |
| PATCH | `/profile` | Manager or Resident own account |
| POST / PATCH / DELETE | `/rooms`, `/rooms/:id` | Assigned Manager |
| POST | `/rooms/:id/replace-meter` | Assigned Manager; validates final billing |
| POST | `/residents` | Assigned Manager; creates resident and tenancy |
| PATCH | `/residents/:id` | Manager of resident's active house |
| POST | `/residents/:id/end`, `/residents/:id/move`, `/residents/:id/set-password` | Assigned Manager |
| POST | `/rent/generate` | Assigned Manager; idempotency key required |
| POST | `/electricity/preview`, `/electricity/issue`, `/electricity/rates` | Assigned Manager (issue requires idempotency key) |
| POST | `/payments` | Assigned Manager (idempotency key required) |

**Finance:** Monetary amounts use integer strings in minor units (BDT paisa). Meter readings use decimal strings. The mobile API delegates bill generation and payment transactions to existing proven billing/collection services, so bill history and admin-web reports share PostgreSQL records.

## Existing business rules retained

- Tenancy, rent term changes and meter replacements require first-of-month boundaries, as already required by the backend.
- Electricity cannot be issued for a future reading date; a valid installed meter, accepted previous reading, active tenancy, and effective tariff must already exist.
- A payment cannot exceed a bill's remaining balance. Payment receipt and bill update occur in one DB transaction.
- Old bills, reversed payments, and receipts stay immutable under the existing DB triggers.
- Mobile room assignments, payment reads and mutations are checked against manager-assignment rows on the server. Resident responses are scoped to their own tenancies; no cross-tenant objects are fetched.

## Validation still required before live cutover

The environment used to assemble this package could **not install the NestJS packages or access the production database**. Source files were transpiled with the system TypeScript compiler, all emitted JS passed Node's syntax check, and existing source files were compared unchanged. Run these in your configured backend environment:

```bash
npm ci
npm run build
npm test
```

Perform an end-to-end smoke test on the migrated database: admin-web login and CRUD; Manager login and property scope; create a room with baseline; create/assign a resident; generate a rent bill; issue a meter bill; record one payment with a stable idempotency key; verify balances in both app and admin web; Resident login and history; Admin mobile read-only; logout and expired token. **Do not claim release readiness until these checks pass.**
