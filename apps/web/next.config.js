/** @type {import('next').NextConfig} */
const nextConfig = {
  // @gauntlet/core has no build step of its own (its package.json "exports"
  // points straight at TypeScript source, per the monorepo's no-separate-
  // build-for-internal-packages convention) -- transpilePackages tells
  // Next's own compiler to transpile it rather than treating it as
  // pre-built, external code.
  transpilePackages: ["@gauntlet/core"],
  webpack: (config) => {
    // Our own relative imports (lib/run-scan.ts importing "./store.js", for
    // example) follow TypeScript's NodeNext convention: an ESM import
    // specifier must carry the *emitted* extension (.js) even though the
    // source file on disk is .ts -- tsc understands this and resolves it
    // correctly (confirmed: `npm run typecheck` passes clean). Webpack's
    // resolver does not know this convention out of the box: given an
    // explicit ".js" extension it looks for a literal store.js and stops,
    // instead of falling through to store.ts. extensionAlias is webpack's
    // own documented mechanism for exactly this gap -- found via the real
    // `next dev` error ("Module not found: Can't resolve './store.js'"),
    // not applied speculatively.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

module.exports = nextConfig;
