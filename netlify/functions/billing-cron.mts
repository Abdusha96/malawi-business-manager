// Netlify replacement for the Vercel cron in vercel.json: calls /api/cron/billing once a day at
// 01:00 UTC (03:00 Africa/Blantyre) with CRON_SECRET as the Bearer token. Scheduled functions only
// run on published production deploys.
export default async () => {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const origin = (process.env.URL ?? "").replace(/\/+$/, "");
  if (!secret || !origin) {
    console.warn("billing-cron skipped: CRON_SECRET or URL is not set.");
    return;
  }
  const res = await fetch(`${origin}/api/cron/billing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  console.log(`billing-cron: /api/cron/billing responded ${res.status}`);
};

export const config = {
  schedule: "0 1 * * *",
};
