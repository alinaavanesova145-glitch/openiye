/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Required: ensures Three.js, R3F, and Drei are transpiled through Next's
  // bundler rather than treated as bare ESM externals (Next 14 compatibility).
  transpilePackages: ['three', '@react-three/fiber', '@react-three/drei'],

  webpack(config) {
    // Silence "Critical dependency: the request of a dependency is an expression"
    // warning emitted by some Three.js add-ons that use dynamic require().
    config.module.exprContextCritical = false;
    return config;
  },
};

module.exports = nextConfig;
