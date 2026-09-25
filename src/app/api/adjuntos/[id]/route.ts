import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import { leerAdjunto } from '@/lib/adjuntos/adjuntos';
import { obtenerUsuario } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sirve un adjunto solo a quien puede ver el registro al que pertenece (incluida la seguridad por fila).
 * Sin permiso y no existe dan la misma respuesta, para no revelar qué adjuntos hay.
 * `?descargar=1` fuerza la descarga; sin él, PDF e imágenes se abren en el navegador.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await obtenerUsuario();
  if (!u || u.debeCambiarPassword) return Response.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: 'No encontrado' }, { status: 404 });

  let adjunto;
  try {
    adjunto = await leerAdjunto(await getDb(), almacenEnDisco(), u, id);
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'No se pudo leer el archivo' }, { status: 500 });
  }
  if (!adjunto) return Response.json({ error: 'No encontrado' }, { status: 404 });

  const descargar = new URL(req.url).searchParams.get('descargar') === '1';
  const nombre = adjunto.nombre.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new Response(new Uint8Array(adjunto.bytes), {
    headers: {
      'Content-Type': adjunto.tipo_contenido,
      'Content-Length': String(adjunto.bytes.length),
      'Content-Disposition': `${descargar ? 'attachment' : 'inline'}; filename="${nombre}"; filename*=UTF-8''${encodeURIComponent(adjunto.nombre)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
