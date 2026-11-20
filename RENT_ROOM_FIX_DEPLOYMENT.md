# Room selection & automatic rent statement fix (additive mobile update)

This patch intentionally preserves the existing Admin Web authentication, billing, property and collections endpoints and existing PostgreSQL tables. No schema migration is needed for this patch. Deploy over the current Vercel backend project, with existing database credentials and all existing environment variables unchanged.

## What changed

- `src/mobile/mobile-rent.service.ts` (new): protected, idempotent scheduled rent issuance; mobile-only oldest-first rent payment allocation.
- `src/mobile/mobile-rent-cron.controller.ts` (new): secured scheduled endpoint.
- `src/mobile/mobile.controller.ts` and `src/mobile/mobile.module.ts`: register only the new mobile route/service.
- `src/mobile/mobile.service.ts`: include `tenancyId` on already existing mobile-bootstrap bill data so the mobile app never carries forward a different occupant's balance.
- `vercel.json`: adds a daily scheduled job while retaining the same `nestjs` framework setting and existing routes.
- Flutter: house/room selector, refresh action, rent statement and multi-bill receipts.

## Billing policy

At **00:10 Asia/Dhaka on each day** (18:10 UTC the previous day), Vercel's scheduler checks the current billing month and creates any missing issued rent bills for tenancies occupying the entire month. This means new months are generated on the **1st**, with a daily retry for delayed runs and tenancies assigned after the initial scheduled run. Deployment and plan scheduling accuracy are governed by Vercel; exact minute execution is not guaranteed.

Monthly rent bills contain **only that month's rent**. The mobile statement adds outstanding rent from earlier issued bills for the *same tenancy*, displayed as a carry-forward, without inserting the same debt a second time. A single mobile payment is allocated oldest unpaid month first, inside one DB transaction. Each monthly allocation gets its own original receipt number. Web Admin collections behavior remains unchanged.

Vacant rooms are displayed but have no generated rent bill. Future-month collection is blocked.

## Vercel configuration

1. Back up production PostgreSQL before release.
2. Add a new environment variable to the **existing** Vercel backend project: `CRON_SECRET`, a strong random secret of at least 20 characters (e.g. produce with `openssl rand -hex 32`). Do not put it in Flutter or commit it.
3. Keep `DATABASE_URL`, `SUPABASE_DB_CA_CERT` and all existing production environment settings.
4. Use **Node 24** (per `package.json`), then deploy the updated backend to the **same** Vercel project (`npm ci && npm run build && vercel --prod`). Existing migration 006 must already be installed from the prior mobile release.
5. Vercel will call `GET /api/v1/mobile/jobs/rent` with `Authorization: Bearer $CRON_SECRET`. Requests without the exact secret are rejected.
6. To trigger/test it manually, securely send the bearer secret from a private terminal: `curl -sS -H "Authorization: Bearer $CRON_SECRET" https://YOUR-EXISTING-BACKEND/api/v1/mobile/jobs/rent`. The response contains `{month,created}`. Repeat: the second call should return `created: 0` if no new tenancy was added. Never paste this secret in public logs.
7. Verify existing Admin Web screens still load, then launch the Flutter app with `HOUSELEDGER_API_BASE_URL=https://housemanager-umber.vercel.app/api/v1` (or your actual Vercel domain).

## Mobile check

1. Sign in as a manager who is assigned to the villa/house.
2. Under **My Rooms**, select the house and tap **Refresh rooms**. Confirm all rooms appear, even if they have no bill and no resident.
3. Add a room: it should remain visible in that house immediately. A vacant room cannot be charged rent; assign a resident first.
4. Open **Collect rent**, select **Villa / House** and **Room**, then check `This month rent + Previous months due = Total payable`.
5. If prior rent due is BDT 6,000 and current rent due BDT 10,000, the total payable displays BDT 16,000. Paying BDT 13,000 settles the old BDT 6,000 first and applies BDT 7,000 to the current month; the remaining payable becomes BDT 3,000. The old due is never duplicated in the new `bills.amount_minor`.

## Limitations

This patch does not change existing Admin Web logic or retrofit old rent bills. For exact fractional-taka debt, the existing Admin Web is still required because Flutter's amount input uses whole BDT. Initial installation's `006_mobile_resident_profiles.sql` migration remains required for mobile bootstrap. The backend and Flutter runtime build/tests must be run in an environment with working Node 24 and Flutter SDK before production release.
