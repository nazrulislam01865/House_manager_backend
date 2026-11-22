# HouseLedger — Mobile Profiles, Private Images and Left-Side Menu

## What was changed

### Flutter (manager, resident and administrator)
- Tap the logo / menu glyph in the upper-left header to slide in a persistent left-side menu. The menu contains **My profile**, role-specific destinations, and a separate **Sign out** item at the bottom, with confirmation.
- Removed the old Sign out actions from Manager Home, Resident Profile and Admin Account. For accounts with no assigned house, the empty state offers access to the same menu.
- Added one reusable profile editor for the current authenticated account (all three roles), with full name and mobile, plus optional email, NID number, present address, permanent address, emergency contact, occupation, profile photo and NID photo.
- Manager → Room → Resident details → **Edit resident profile & documents** allows updating a resident in an assigned house with an ongoing or upcoming tenancy. Manager → Assign resident also offers collapsible optional details and images at account creation.
- Manager room cards, admin house room cards and resident account UI show the actual private profile picture or the bundled fallback silhouette.
- Previously implemented bottom navigation, rent/electricity billing and Excel export logic were left as-is.

### NestJS API / database
- Migration `008_mobile_profiles_private_media.sql`: new `mobile_profile_details` table, optional details and private storage object paths; existing resident email records migrated forward.
- Authenticated API routes under `/api/v1/mobile`:
  - `GET/PATCH /profile`
  - `GET/PATCH /residents/:id/profile` (manager of a currently assigned house (including upcoming tenancy))
  - `GET/POST/DELETE /profile/images/:kind`
  - `GET/POST/DELETE /residents/:id/profile/images/:kind` (`kind` = `avatar` or `nid`)
- Mobile profile records remain scoped to the current account or assigned resident. Admin accounts are allowed to read organization resident **avatars only** for room display; they cannot read another person's NID image or edit that profile using this mobile API.
- Private images are stored in **Supabase Storage**, with paths in PostgreSQL. No images are stored in Vercel's ephemeral filesystem. Media are served to the app through authenticated backend endpoints, not public image URLs.
- Image uploads: JPEG/PNG/WebP, 1.5 MB raw maximum; rejected without a configured bucket or secret. Android/iOS app image_picker resizes to a max of 1280 px at quality 76.
- One-device-per-account session policy remains unchanged.

## Required setup before using it in production

1. Back up your production PostgreSQL database.
2. In the **same Supabase project** currently connected to your app, open **Storage → New bucket**. Name the bucket **`houseledger-profiles`** (or configure another valid bucket name). Set **Public = OFF**. Restrict MIME types to `image/jpeg`, `image/png`, `image/webp`; maximum file size 1.5 MB or slightly higher if a vendor UI uses decimal-vs-binary units. Do not use a public bucket for NID documents.
3. On the **NestJS Vercel backend project only**, configure these environment variables:

   ```env
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_SECRET_KEY=YOUR_PRIVATE_SERVER_SIDE_SECRET_KEY
   SUPABASE_PROFILE_BUCKET=houseledger-profiles
   ```

   A legacy service role JWT works with `SUPABASE_SERVICE_ROLE_KEY` if you do not yet have a new secret key. Do not put any secret/service-role key in Flutter, in Dart defines, or in the web frontend. No need to upload the key to ChatGPT.
4. Redeploy the backend after setting the environment variables. Run migration `008` (with all previous migrations applied) against **the production `DATABASE_URL`** before serving the new code. From a trusted environment configured with the production database URL:

   ```bash
   npm ci
   npm run db:migrate
   npm run build
   ```

   Only run the migration once per environment; the app's migration runner records applied files. If your workflow deploys through GitHub → Vercel, commit the backend sources and deploy **after** the migration. Confirm that the Vercel project is using Node 24 as required by `package.json`.
5. Deploy the updated Flutter app, after the backend schema and endpoints are live:

   ```bash
   flutter clean
   flutter pub get
   flutter analyze
   flutter test
   flutter run --dart-define=HOUSELEDGER_API_BASE_URL=https://housemanager-umber.vercel.app/api/v1
   ```

## Manual acceptance checklist

- [ ] Login as Admin → header logo opens left menu → My profile → update details, upload/change/remove own portrait and optional NID photo → revisit profile and check saved data.
- [ ] Login as Manager → header logo menu → update profile → Sign out asks for confirmation and returns to sign-in.
- [ ] Login as Manager → create a resident with **only required fields** → succeeds without any image or optional data.
- [ ] Assign resident with optional email/address/NID and two photos → one-time password is displayed before optional uploads; after completion the resident portrait appears beside room number in Rooms.
- [ ] Manager edits an assigned resident → changes persist → resident logs in and sees the same personal details.
- [ ] Resident changes their own profile and documents → Manager sees the new portrait on the room card after refresh.
- [ ] Manager from another house cannot access a resident's profile or NID image (403). Admin cannot read a different person's NID image (403).
- [ ] Remove avatar → room card renders fallback picture. Remove NID photo → file is no longer available in the mobile API.
- [ ] Test gallery/camera permissions and small-screen layout on real Android/iOS devices.
- [ ] Existing rent, electricity, reports, Excel download and single-device login flows still work.

## Verification status in this environment

- Verified: both uploaded archive contents were inspected; TypeScript sources passed syntax-parser checks; Flutter relative imports, delimiter structure and assets checked; ZIP integrity checked.
- Not verified: full NestJS compilation/integration tests (package install was not available), Flutter SDK compilation/analyze/widget tests (SDK unavailable here), live Supabase credentials, Vercel deployment, real-device UI.

**Important:** Deploying only the Flutter ZIP will not enable private photo uploads. The new backend **migration**, backend code, Supabase bucket and backend-only environment variables are required.

### Supabase API key compatibility
Use the server-side `sb_secret_...` key in `SUPABASE_SECRET_KEY` where supported. Opaque keys are sent in the `apikey` header, not as JWT bearer tokens; legacy `service_role` JWTs retain their bearer header. Never publish a secret key or commit it to source control.
