// Ambient module declaration for CSS imports (e.g. Math.ts lazily importing
// katex's stylesheet). The consuming app's bundler (Vite) resolves these at
// build time; tsc only needs the module shape. The frontend gets this from
// `vite/client` — this package doesn't depend on vite, so declare it here.
declare module "*.css";
