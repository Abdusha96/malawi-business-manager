/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "5mb" }, // headroom for future receipt/logo uploads
  },
};

module.exports = nextConfig;
