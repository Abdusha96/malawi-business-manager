# Production Deployment Runbook

This runbook is the release checklist for a production deployment. Keep secrets in the host's secret manager, never in source control or deployment logs.

## 1. Choose the host and production services

- Choose a Node.js host that supports the project's Next.js App Router and PostgreSQL connections through its supported Prisma configuration.
- Use managed PostgreSQL with encrypted connections, automated backups and point-in-time recovery. Set and document the provider's retention window and recovery owner.
- Before launch, restore a production-like backup into a separate database and confirm the app can use it. A backup that has never been restored is unverified.
- Configure a stable HTTPS domain and set NEXTAUTH_URL to that public origin.
- Configure host-level edge/WAF rules for login attempts and public invoice-payment endpoints. Keep provider webhooks reachable; do not apply a browser challenge to them.

## 2. Configure environment variables

Start from .env.example; set values in the host dashboard or secret manager. npm run check:production-env checks the required variables and basic formats without printing their values.

Required for an authenticated production app:

- DATABASE_URL: production PostgreSQL connection string.
- NEXTAUTH_URL: public HTTPS origin.
- NEXTAUTH_SECRET: at least 32 random characters.
- CRON_SECRET: at least 32 random characters.

Configure only the optional integrations being launched:

- Email: EMAIL_PROVIDER_API_KEY and a verified EMAIL_FROM.
- SMS: SMS_PROVIDER_API_KEY and SMS_PROVIDER_USERNAME.
- SMS delivery callbacks: AT_DELIVERY_REPORT_SECRET, configured with the Africa's Talking callback.
- Platform plan billing: PAYCHANGU_SECRET_KEY, PAYCHANGU_WEBHOOK_SECRET, NEXTAUTH_URL, and BILLING_REQUIRE_PAYMENT=true. This blocks paid-plan activation when a confirmed gateway payment is required.
- Business-owned online invoice payments: a stable APP_ENCRYPTION_KEY (32 bytes). Back it up separately from the database; losing it requires businesses to re-enter their gateway keys.
- AI assistant: ANTHROPIC_API_KEY (and optionally ANTHROPIC_MODEL).

Use the matching test or sandbox credentials in staging. Do not copy local .env values into production without rotating them and confirming their scope.

## 3. Deploy schema and application

For a new or existing production database:

1. Take a database backup before applying schema changes.
2. Run npx prisma migrate deploy from the release against the production database.
3. Run npm run prisma:seed for a fresh database or when new base permissions/plans have been added. The seed uses upserts.
4. Run npm run prisma:generate if the host's install lifecycle does not generate the Prisma client.
5. Run npm run check:production-env in the production environment, then deploy the built application.
6. Verify sign-in, registration, one sale, one purchase, one expense, one invoice PDF, one report, and one backup restore in staging before opening production to customers.

The current schema baseline is in prisma/migrations. Use migrate deploy in production; do not use migrate dev against production.

## 4. Schedule the background task

The repo includes vercel.json with a daily schedule for /api/cron/billing at 01:00 UTC (03:00 in Africa/Blantyre). Vercel sends the project variable CRON_SECRET as a Bearer authorization header. This schedule is created on production deployment; preview deployments do not run it.

Vercel Hobby permits daily schedules, so this cadence works on Hobby. Hobby timing precision is up to an hour, so expect the call between 01:00 and 02:00 UTC (03:00 and 04:00 in Malawi). Check Vercel's current [Cron usage limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [secret header behavior](https://vercel.com/docs/cron-jobs/manage-cron-jobs). If using another host, configure its scheduler to call:

~~~text
POST https://YOUR_DOMAIN/api/cron/billing
Authorization: Bearer YOUR_CRON_SECRET
~~~

Run the scheduler once per day. Confirm a valid call returns HTTP 200 and an invalid/missing secret returns 401/503. The job reconciles pending gateway payments, sends renewal reminders, and retries eligible failed messages. Payment reconciliation, renewal notices, and queued notification retries can be delayed until the next daily run.

## 5. Staging integration checks

Before enabling customer-facing integrations in production:

- PayChangu: verify hosted checkout, browser return, signed webhook, server-side payment verification, repeated webhook delivery, underpayment, and the invoice-paid-by-another-method case. Confirm pending payments reconcile through cron.
- Refunds: confirm the operator knows the app records the refund but the money must be returned through PayChangu outside the app.
- Email: send and receive an account-verification message and password-reset message from the production sender domain.
- SMS: send one authorized test message, receive its delivery callback, and verify an undelivered result is visible in the Notifications page.
- Run one cron invocation in staging after integration checks and inspect its response without logging secrets or customer data.

The project has no live-provider evidence yet. Do not claim gateway or handset-delivery behavior is production-validated until these checks pass.

## 6. External launch approvals

- Have qualified counsel review the Privacy and Terms pages for the actual operator, data handling, retention, payment and jurisdiction practices.
- Confirm the business's tax/accounting workflows and public marketing claims with a qualified local reviewer. The app does not file returns with MRA.
- Pick and document a support owner for payment disputes, manual refunds, failed messages, encryption-key recovery and database restoration.

## Still outside this release runbook

Recurring invoices, approval workflows, purchase orders, sales orders, native mobile applications, MRA filing, Excel workbook export and Careers/Blog pages are not implemented. Launch only if those features are not part of the accepted release scope.
