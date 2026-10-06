import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return ["", "/about", "/contact", "/help", "/docs", "/guides", "/privacy", "/terms", "/security"].map((p) => ({ url: `${base}${p}` }));
}
