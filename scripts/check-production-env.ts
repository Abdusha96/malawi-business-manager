const errors: string[] = [];
const warnings: string[] = [];

function value(name: string): string {
  return (process.env[name] ?? "").trim();
}

function required(name: string): string {
  const v = value(name);
  if (!v) errors.push(`${name} is required.`);
  return v;
}

const databaseUrl = required("DATABASE_URL");
if (databaseUrl && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  errors.push("DATABASE_URL must use PostgreSQL.");
}

const appUrl = required("NEXTAUTH_URL");
if (appUrl) {
  try {
    const parsed = new URL(appUrl);
    if (parsed.protocol !== "https:") errors.push("NEXTAUTH_URL must use HTTPS in production.");
  } catch {
    errors.push("NEXTAUTH_URL must be a valid absolute URL.");
  }
}

for (const name of ["NEXTAUTH_SECRET", "CRON_SECRET"]) {
  const secret = required(name);
  if (secret && secret.length < 32) errors.push(`${name} must contain at least 32 characters.`);
}

const emailKey = value("EMAIL_PROVIDER_API_KEY");
if (emailKey && !value("EMAIL_FROM")) warnings.push("EMAIL_PROVIDER_API_KEY is set but EMAIL_FROM is empty; configure a verified sender address.");

const smsKey = value("SMS_PROVIDER_API_KEY");
if (smsKey && !value("SMS_PROVIDER_USERNAME")) errors.push("SMS_PROVIDER_USERNAME is required when SMS_PROVIDER_API_KEY is set.");

const payChanguKey = value("PAYCHANGU_SECRET_KEY");
if (payChanguKey && !value("PAYCHANGU_WEBHOOK_SECRET")) warnings.push("Configure PAYCHANGU_WEBHOOK_SECRET in production and use the same value in the provider dashboard.");
if (!payChanguKey && value("BILLING_REQUIRE_PAYMENT").toLowerCase() === "true") {
  warnings.push("Paid plan checkout is blocked until PAYCHANGU_SECRET_KEY is configured.");
}

const encryptionKey = value("APP_ENCRYPTION_KEY");
if (encryptionKey) {
  const bytes = /^[\da-f]{64}$/i.test(encryptionKey)
    ? 32
    : (() => {
        if (!/^[A-Za-z\d+/]+={0,2}$/.test(encryptionKey)) return 0;
        try { return Buffer.from(encryptionKey, "base64").length; } catch { return 0; }
      })();
  if (bytes !== 32) errors.push("APP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
}

if (warnings.length) {
  console.warn("Production configuration warnings:");
  warnings.forEach((warning) => console.warn(`- ${warning}`));
}
if (errors.length) {
  console.error("Production configuration errors:");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log("Required production environment configuration is present and structurally valid.");
  if (warnings.length) console.log("Resolve any warnings for the features you plan to enable.");
}
