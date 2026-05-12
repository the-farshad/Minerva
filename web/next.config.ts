import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Per-route body-size cap. The default 1 MB ceiling breaks the
  // video upload flow (MP4s are routinely 10-200 MB). Bump for
  // server actions / app-router routes that read the request body.
  experimental: {
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
};

export default nextConfig;
