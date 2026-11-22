# HouseLedger — manager Excel export format update

## Updated source

- Backend: uploaded `Archive(8).zip` (NestJS/PostgreSQL), with the source in `src/mobile/` updated.
- Flutter: uploaded `Archive 2(4).zip`, retaining its existing mobile design and navigation. Only the relevant export button text and the shared report title were updated.
- **No database schema migration, bill calculation, payment write logic, session handling, login, or manager permissions were changed.**

## Where to export

From the manager mobile app, use **Reports > Export room-wise Excel**. You can choose **All assigned houses** or a particular house and a month. The monthly statement screen also exports the same first-sheet format for the selected house.

Existing authorized endpoints are unchanged:

- `GET /api/v1/mobile/reports/full/export?month=YYYY-MM` — all assigned houses
- `GET /api/v1/mobile/reports/full/export?month=YYYY-MM&houseId=<UUID>` — one assigned house
- `GET /api/v1/mobile/statements/export?month=YYYY-MM&houseId=<UUID>` — single-house monthly statement

All require a manager session, and every room lookup is constrained to the manager's **current active house assignments**.

## Required first worksheet (for each house)

Top bar:

- House name — sourced from `houses.name`
- Address — sourced from `houses.address`
- Manager name — current authenticated manager user
- Mobile number — current authenticated manager's stored phone number
- Billing month and currency (BDT)

The column order **exactly** matches the request:

`Id | Name of the room user/rent | Mobile number | Room no | Meter no | Running month rent | Electricity unit | Electricity bill | Total bill | Paid | Remaining`

One numbered row is exported **per room**, including currently unbilled and vacant rooms. Each house gets its own worksheet when the export covers multiple assigned houses. Historical month labels prefer the bill's recorded resident and bill meter segments; unbilled rooms use the resident/meter installation overlapping the billing month.

- **Running month rent**: issued rent bill amount(s) for that room and selected billing month.
- **Electricity unit**: total billed electricity usage (kWh) from the month's electricity bill segments.
- **Electricity bill**: issued electricity charge amount(s) for that room and month.
- **Total bill**: `Running month rent + Electricity bill` (Excel formula, cached amount provided).
- **Paid**: total *current* amount paid against the same month's issued rent and electricity bills, including any reversals already reflected in `bills.paid_minor`.
- **Remaining**: `Total bill - Paid` (Excel formula, cached amount provided).

The last row totals amounts, units and balances using Excel `SUM` formulas, with cached values precomputed for preview applications. The report uses 11 columns, a styled top bar, a frozen table header, filters, appropriate formatting and landscape print setup. Phone numbers and other user-supplied strings remain **text**, not executable formulas.

**Accounting caveats:** The report counts **ISSUED** rent and electricity bills only. A room that has not yet been billed displays a zero/dash, *not* an assumed expected charge. Paid and remaining values show bill balances as of export time, not retroactive month-end positions; separately, cash received **during the month** is still available in the full report's receipt worksheets. Only the currently recorded bill/payment data is used. An `Id` is a sequential row number, not a database UUID.

## Existing detailed workbook sheets retained

- Full manager report: house-by-house room sheets followed by the original nine detailed sheets (`Overview`, `Property Summary`, `Rent Bills`, `Electricity Bills`, `Month Receipts`, `Outstanding Dues`, `Monthly Trend`, `Payment Methods`, `Electricity Meters`).
- House monthly statement: the new `Monthly Report` first sheet plus the original five (`Summary`, `Rent Bills`, `Electricity Bills`, `Meter Details`, `Receipts`).

## Deploy and verify

1. Back up source and database. Deploy the updated backend and Flutter projects as a **matched pair**. No new migration is required for this particular Excel export change; any earlier outstanding project migrations still apply.
2. Backend (with supported Node 24): `npm ci`, `npm run build`, `npm run test:statement` before deploying/restarting NestJS or redeploying Vercel. Verify deployment retains the working PostgreSQL connection.
3. Flutter: `flutter pub get`, `flutter analyze`, `flutter test`. Build with the correct `--dart-define=HOUSELEDGER_API_BASE_URL=https://.../api/v1` and install on a test device.
4. As a manager, export a month with both rent and electricity, at least one partial payment and a vacant room. Check the **Monthly Report** first sheet and totals. Verify the manager name and mobile number and each property's own address. With **All assigned houses**, open every room-wise worksheet.
5. Check that a different manager cannot export a house not assigned to them and that resident/admin accounts cannot access the manager reporting API.

### Verification completed for this source update

- All 3 OOXML writer regression tests passed, including an all-house export case and formula-looking tenant name safety checks.
- `openpyxl` opened the generated `.xlsx` files and verified column order, header names, sheet structure, cached total/remaining formulas, a vacant room, filters, frozen panes and totals.
- The 4 changed backend source files were transpiled with TypeScript syntax diagnostics and corresponding `dist/mobile` JS refreshed. The runtime still needs a full `npm run build` using the real dependencies before production deployment.
- Full NestJS typechecking, PostgreSQL integration and Flutter compile/widget tests could not be completed here because the required local SDK/dependencies were unavailable.

**No live server or database was modified.** The preview Excel files contain fabricated sample data, not customer records.
