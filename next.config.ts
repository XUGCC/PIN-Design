import type { NextConfig } from "next";

const withPWA = require("next-pwa")({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
  buildExcludes: [/middleware-manifest\.json$/],
  maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
  runtimeCaching: [
    {
      urlPattern: ({ request }: { request: Request }) => request.mode === "navigate",
      handler: "NetworkFirst",
      options: {
        cacheName: "workbench-pages",
        networkTimeoutSeconds: 3,
        expiration: {
          maxEntries: 30,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        },
      },
    },
    {
      urlPattern: /\/_next\/static\//,
      handler: "CacheFirst",
      options: {
        cacheName: "workbench-static",
        expiration: { maxEntries: 120, maxAgeSeconds: 365 * 24 * 60 * 60 },
      },
    },
    {
      urlPattern: /\.(?:png|jpg|jpeg|svg|webp|gif|ico)$/i,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "workbench-images",
        expiration: { maxEntries: 60, maxAgeSeconds: 60 * 24 * 60 * 60 },
      },
    },
  ],
});

const isGithubPages = process.env.GITHUB_PAGES === "1";

const nextConfig: NextConfig = {
  ...(process.env.SITES_STATIC_EXPORT === "1"
    ? { output: "export", images: { unoptimized: true } }
    : {}),
  ...(isGithubPages
    ? {
        // PIN-Design is deployed as a GitHub Pages project site rather than
        // from the domain root. Keep Next assets, links, and the service
        // worker inside that project path.
        basePath: "/PIN-Design",
        assetPrefix: "/PIN-Design/",
        trailingSlash: true,
      }
    : {}),
};

export default withPWA(nextConfig);
