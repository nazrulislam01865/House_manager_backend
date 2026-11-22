# HouseLedger: Complete manager reporting (Flutter + NestJS)

## Scope implemented
The manager's **Reports** bottom tab is now a full, live-data reporting hub. Select one active assigned house or **All assigned houses**, and a billing month. The dashboard displays:

- Rent and electricity invoiced for the selected billing month, amounts paid against those bills, and remaining balances.
- **Actual cash collected during the calendar month**, independently of the bill month, split by rent/electricity and payment method. Reversals reduce receipts.
- All currently unpaid bills whose billing month is on/before the selected month, including previous-month balances. Payment history and electricity meter details are expandable.
- Total rooms, currently occupied/vacant, and each selected property's financial figures.
- Six-month trend: bills issued by billing month versus payments received by transaction month.
- Search and category filters, expandable bill/payment details, and progressive list loading on mobile.
- An **Export full Excel report** action, with nine sheets: Overview, Property Summary, Rent Bills, Electricity Bills, Month Receipts, Outstanding Dues, Monthly Trend, Payment Methods, Electricity Meters. The exported workbook includes **all matching house/month records** regardless of UI pagination/search.

The existing single-house **MonthlyStatementScreen** remains accessible from Rent and Electricity pages and the manager's report property cards.

## Data integrity

- The application has **no operating expense ledger**. Net income/profit is deliberately not calculated; this is stated in the UI and XLSX. No expense values are fabricated.
- `paid_minor` on a bill shows its current paid-to-date amount, **not a reconstructed historic month-end snapshot**. The outstanding section similarly uses **currently** unpaid balances for bills issued through the selected month.
- Cash receipts use `payments.received_at`, including payments for bills from other months. `REVERSAL` rows are negative.
- Only **ISSUED** bills are counted. VOID bills are excluded. Historical electricity meter segments and receipt history remain linked to their bills.
- Manager role and active house assignment are checked on every API call. No organization ID is accepted from the client. Mobile admin/resident cannot read these endpoints.
- This release does not add or change migrations, bill creation logic, payments, or existing single-session security behavior.

## New API endpoints

- `GET /api/v1/mobile/reports/full?month=YYYY-MM` — JSON for all assigned houses.
- `GET /api/v1/mobile/reports/full?month=YYYY-MM&houseId=<UUID>` — JSON for one assigned house.
- `GET /api/v1/mobile/reports/full/export?month=YYYY-MM[&houseId=<UUID>]` — private `.xlsx` attachment.

All three require a valid manager mobile bearer token. Every report query is scoped to the manager's current assignments. The authenticated export is shared/saved by the OS; the server does not create public export URLs.

## Deployment steps

1. Back up the live database and source. These archives retain the earlier **007_single_mobile_session.sql** migration; deploy that if it was not deployed already.
2. Deploy the **backend** archive, run `npm ci`, `npm run db:migrate`, `npm run build`, and restart or redeploy the configured NestJS/Vercel service. Existing environment variables are unchanged.
3. Deploy the **Flutter** archive, run `flutter pub get`, `flutter analyze`, `flutter test`, then build. Use the same `HOUSELEDGER_API_BASE_URL` as the working app.
4. Log in as a manager assigned to at least one house. Open Reports; compare the monthly bill counts, payment receipts and totals with the live database.
5. Check the **All assigned houses** scope and an individual house. Test a manager trying to request an unassigned `houseId` (must be rejected), and resident/admin tokens (forbidden).
6. Open an unpaid past-month electricity bill and verify its meter segment and receipt history. Verify bills with reversed payments.
7. Export to Excel and open the nine worksheets. Confirm the exported dataset includes records beyond the on-screen list limit; confirm currencies and negative reversals.
8. Validate separately on 320/360/430dp phones and tablets. Confirm navigation, month filtering, scrolling, sharing, and login replacement on two physical devices.

## Verification limits

- All 46 backend TypeScript source files passed syntax transpilation checks.
- ZIP/OOXML export regression tests for the previous monthly statement (five sheets) and new full report (nine sheets) passed.
- Full NestJS type-check/database integration and Flutter compile/widget tests could not be run in this environment (app dependencies and Flutter SDK unavailable); **run them before deploying**.

This update is source-only; no live deployment has been performed.
