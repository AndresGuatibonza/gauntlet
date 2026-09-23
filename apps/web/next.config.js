/** @type {import('next').NextConfig} */
const nextConfig = {
  // @gauntlet/core has no build step of its own (its package.json "exports"
  // points straight at TypeScript source, per the monorepo's no-separate-
  // build-for-internal-packages convention) -- transpilePackages tells
  // Next's own compiler to transpile it rather than treating it as
  // pre-built, external code.
  transpilePackages: ["@gauntlet/core"],
};

module.exports = nextConfig;
