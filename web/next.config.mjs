/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  outputFileTracingRoot: new URL('.', import.meta.url).pathname,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
