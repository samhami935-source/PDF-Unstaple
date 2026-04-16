/** @type {import('next').NextConfig} */
// GitHub Pages serves this repo at /PDF-Unstaple/, so when building for
// production we set basePath/assetPrefix. Locally (next dev) we leave them
// empty so http://localhost:3000/ still works.
const repo = "PDF-Unstaple";
const isProd = process.env.NODE_ENV === "production";

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  basePath: isProd ? `/${repo}` : "",
  assetPrefix: isProd ? `/${repo}/` : "",
};
module.exports = nextConfig;
