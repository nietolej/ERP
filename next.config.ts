import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // PGlite carga archivos WebAssembly propios: se ejecuta desde node_modules, sin empaquetar.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Metas por Excel (hasta 2 MB) y adjuntos (hasta 5 MB), más lo que añade el formulario.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
