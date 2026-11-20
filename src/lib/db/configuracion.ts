/** PGlite se limita al desarrollo y a las pruebas. Los errores omiten los datos de conexión. */
export function urlPostgres(url: string | undefined, entorno: string | undefined): string | undefined {
  if (!url && entorno !== 'production') return undefined;
  if (url && /^postgres(?:ql)?:\/\//i.test(url)) {
    try {
      const destino = new URL(url);
      if (destino.hostname || destino.searchParams.get('host') || destino.pathname.length > 1) {
        return url;
      }
    } catch {
      // No propagar el error de URL porque puede incluir credenciales.
    }
  }
  throw new Error('Configure DATABASE_URL con una URL válida de PostgreSQL.');
}
