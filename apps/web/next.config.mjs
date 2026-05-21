/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lets us import workspace packages directly without a build step.
  transpilePackages: ["@zoneops/types"],
  experimental: {
    // App Router defaults are fine; no special opt-ins needed for MVP.
  },
};
export default nextConfig;
