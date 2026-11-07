# HouseLedger — NestJS PostgreSQL Backend

NestJS 12, TypeScript, PostgreSQL via `pg`, migration runner, admin web session auth and manager app bearer auth.

See [SETUP_AND_CONNECTION.md](./SETUP_AND_CONNECTION.md) for local Mac PostgreSQL setup, admin `.env` configuration, real database demo seeding, and the frontend integration procedure.

```bash
npm ci
cp .env.example .env
# Set DATABASE_URL, ADMIN_NAME, ADMIN_USERNAME, ADMIN_PHONE, ADMIN_PASSWORD
npm run db:migrate
npm run admin:seed
# Development workspace only, optional: npm run db:seed:demo
npm run start:dev
```

The manager API stores NID and an Argon2 password hash; house assignment is a separate operation. Web admin routes remain cookie/CSRF protected and app tokens cannot access them. Never run demo seeding in production.
