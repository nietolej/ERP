import { obtenerUsuario } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { detalleDeclaracion } from '@/lib/fiscal/declaraciones';
import { ROLES_VEN_LIBROS } from '@/lib/fiscal/libros';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Descarga el archivo de una declaración (CSV de retenciones de IVA o XML de ISLR) tal como se declaró. Solo para quien ve los libros fiscales. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await obtenerUsuario();
  if (!u || u.debeCambiarPassword) return Response.json({ error: 'No autenticado' }, { status: 401 });
  if (!u.roles.some((r) => (ROLES_VEN_LIBROS as readonly string[]).includes(r))) return Response.json({ error: 'No encontrado' }, { status: 404 });
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: 'No encontrado' }, { status: 404 });
  const d = await detalleDeclaracion(await getDb(), id);
  if (!d?.archivo || !d.archivo_nombre) return Response.json({ error: 'No encontrado' }, { status: 404 });
  const xml = d.archivo_nombre.endsWith('.xml');
  return new Response(d.archivo, {
    headers: {
      'Content-Type': xml ? 'application/xml; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${d.archivo_nombre.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
