// On Netlify, default NEXTAUTH_URL to the deploy's public origin when it isn't configured, so
// next-auth callbacks and emailed links point at the right host. An explicit value always wins.
if (!process.env.NEXTAUTH_URL && process.env.NETLIFY) {
  const origin = process.env.CONTEXT === "production" ? process.env.URL : process.env.DEPLOY_PRIME_URL;
  if (origin) process.env.NEXTAUTH_URL = origin;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: process.env.NEXTAUTH_URL ? { NEXTAUTH_URL: process.env.NEXTAUTH_URL } : {},
  experimental: {
    serverActions: { bodySizeLimit: "5mb" }, // headroom for future receipt/logo uploads
  },
};

module.exports = nextConfig;
