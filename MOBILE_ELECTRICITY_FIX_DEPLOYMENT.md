# HouseLedger mobile electricity and branding fixes (20 November 2026)

## Scope and compatibility

The web-admin controllers/services, database schema, migrations, login and rent Cron are unchanged. This update adds `src/mobile/mobile-electricity.service.ts` and registers its mobile-only billing and collection paths. Do **not** replace the existing Vercel database or environment variables. There is **no new migration**.

### Updated endpoints (existing mobile auth and manager/house authorization required)

- `POST /api/v1/mobile/electricity/preview` validates the month's date, most recent accepted meter reading, active resident, and house tariff. It does not modify data.
- `POST /api/v1/mobile/electricity/issue` atomically creates a new accepted reading and a single electricity invoice for the selected month. Requires a UUID `Idempotency-Key` header and refuses duplicate bills or readings.
- `POST /api/v1/mobile/electricity/handover` records a manager-verified opening meter value on the current resident’s move-in date, before any electricity bill for that tenancy. It is idempotent, audited and does not rewrite the former tenant’s records.
- `POST /api/v1/mobile/electricity/collect` allocates a manager payment to the **same tenancy's** oldest unpaid electricity invoices (up to the selected month). May settle prior-month dues even while this month is awaiting a reading; no unissued bill is invented. Requires a UUID `Idempotency-Key` header.
- `GET /api/v1/mobile/bootstrap` continues to return all scoped rooms, meters, bills and recorded readings; no response-shape breaking change.

## Monthly cycle

The new electricity month is available on the **1st** through the month selector. In contrast to fixed monthly rent, electricity cannot be invoiced accurately until a real current kWh reading is supplied. It remains `Awaiting meter reading` until the Manager reviews and issues it. Previously issued months stay immutable. Arrears are displayed separately and never added to the new usage charge.

The existing Vercel rent Cron continues unchanged (`/api/v1/mobile/jobs/rent`). No electricity Cron inserts zero or estimated bills.

## Deployment

1. Back up PostgreSQL and retain the existing Vercel project and environment configuration.
2. Use **Node.js 24** (the project's `package.json` engine requirement).
3. In the backend root run `npm ci && npm run build`. Resolve build errors before deployment.
4. Deploy the complete updated backend to the **same** Vercel project using `vercel --prod` or the normal Git deployment flow.
5. Smoke-test the existing Admin Web login, house list, tenant and billing pages first.
6. Test Manager Flutter with an assigned house, an occupied room, a linked meter baseline, and an effective tariff. Verify preview, issue, collection, receipt, and new-month `Awaiting reading` state.
7. Verify that a duplicate issue attempt does **not** create another bill and a repeated payment with the same idempotency key creates no duplicate receipts.

## Important valid-data rules

- A reading's date must be later than the most recent accepted reading, inside its bill month and not in the future (Dhaka time).
- A meter installation baseline **may predate the first resident's move-in date**. This fixes an erroneous first-bill rejection.
- If the same meter was previously billed to **a different tenant**, a verified handover reading is needed before the next resident can be billed. The Manager can use **Meter reading > Opening reading at move-in** to record the actual handover value; the service blocks guessed dates, readings below the meter baseline and changes after new bills have been issued. Do not bypass this accounting protection.
- A house must have a positive unit tariff effective at the beginning of the selected billing month.
- Money and kWh calculations use Decimal.js on the server. The Flutter form currently accepts whole BDT amounts only; fractional-BDT payments belong in Admin Web.

## Verification limitation

The revised mobile TypeScript files passed syntax parsing and ZIP integrity checks. A full NestJS build, live PostgreSQL tests, Flutter analyzer and on-device screenshot review were not available in the authoring environment. Run the build/test commands above before production rollout.
