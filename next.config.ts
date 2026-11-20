import type { NextConfig } from "next";

import { PHASE_PRODUCTION_SERVER } from 'next/constants';
import { urlPostgres } from './src/lib/db/configuracion';

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

export default function configurar(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_SERVER) urlPostgres(process.env.DATABASE_URL, 'production');
  return nextConfig;
}
