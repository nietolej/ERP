import { obtenerUsuario } from '@/lib/auth/dal';
import { ROLES_CARGAN_PRODUCTOS, plantillaCsv } from '@/lib/maestros/carga-productos';

/** La plantilla CSV de la carga masiva de productos (§14.4): solo para quien puede cargar. */
export async function GET() {
  const u = await obtenerUsuario();
  if (!u || u.debeCambiarPassword) return Response.json({ error: 'No autenticado' }, { status: 401 });
  if (!u.roles.some((r) => (ROLES_CARGAN_PRODUCTOS as readonly string[]).includes(r))) return Response.json({ error: 'No encontrado' }, { status: 404 });
  return new Response(plantillaCsv(), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="plantilla-productos.csv"',
      'Cache-Control': 'private, no-store',
    },
  });
}
