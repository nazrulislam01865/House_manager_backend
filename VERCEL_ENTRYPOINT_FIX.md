# HouseLedger Vercel 500: invalid default export

## Cause

The Vercel Function logs show:

`Invalid export found in module "/var/task/src/main.js". The default export must be a function or server.`

The original `src/main.ts` only called `app.listen()`. The updated file **also exports a default HTTP handler**, which initializes NestJS once per warm Vercel Function instance via `app.init()` and dispatches requests through the existing Express adapter. Normal local listening mode and all existing controller routes are retained.

## Recommended application method

**Apply only `src/main.ts` and the Node version change**, rather than overwriting your repository with an older snapshot. The supplied source archive was from November 7, while the Vercel logs were generated November 13; the deployed source may contain newer changes. Preserve unrelated customizations.

1. Copy `src/main.ts` into your current backend, reviewing any local changes first.
2. In the current backend `package.json`, change `engines.node` from `>=22.16` to `24.x` (optional but recommended to avoid automatic Node 26 upgrades). Update the lockfile via `npm install --package-lock-only` if you change it.
3. In Vercel **Settings > Environment Variables**, remove the custom `NODE_ENV=development` override or change it to `production` for Production; ensure `DATABASE_URL`, `FRONTEND_ORIGINS`, `DB_POOL_SIZE` are set. Vercel automatically supplies `VERCEL=1` and it must not be set locally.
4. Confirm the framework is NestJS, with no Vite/`dist` static output override. Retain your existing correctly configured Vercel project and `vercel.json` if present.
5. Run `npm ci`, `npm run build`, and `npm test` in the backend. Node 24 is recommended. Verify that `argon2` native bindings are included if login fails.
6. Commit/push the changed files, wait for the actual deployment status, then request `GET https://housemanager-umber.vercel.app/api/v1/health`.
7. If you get a new 500, review the new Vercel Function logs; initialization exceptions are logged as `[HouseLedger] Vercel initialization failed:` without leaking credentials to the HTTP response.

Do not rerun database migrations or reseed the admin for this entry-point error. Keep the database password private and rotated if it has been shared.

## Verification limit

Static TypeScript parsing and ESM transpilation were checked. Full npm installation and integration tests could not be executed here because package installation failed. Test locally before deploying to production.
