import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The API is a separate Fastify process (as Dokmee's web tier was separate
  // from its services). Proxying keeps the browser on one origin, so the
  // session cookie is first-party.
  async rewrites() {
    const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';
    return [
      { source: '/trpc/:path*', destination: `${api}/trpc/:path*` },
      { source: '/file/:path*', destination: `${api}/file/:path*` },
      { source: '/upload/:path*', destination: `${api}/upload/:path*` },
    ];
  },
};

export default config;
