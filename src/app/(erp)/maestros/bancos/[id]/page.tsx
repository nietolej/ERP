import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_ADMIN_BANCOS } from '@/lib/maestros/bancos';
import { actualizarBancoAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BancoPage({ params }: { params: Promise<{ id: string }> }) {
  await exigirRol(...ROLES_ADMIN_BANCOS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const { rows } = await db.query<{ codigo: string; nombre: string; pais: string; activo: boolean }>(
    'select codigo, nombre, pais, activo from banco where id = $1', [id]);
  const b = rows[0];
  if (!b) notFound();

  return (
    <>
      <Encabezado titulo={`Banco ${b.codigo} · ${b.nombre}`}>
        <Link href="/maestros/bancos" className="text-sm text-texto-2 hover:text-texto">← Bancos</Link>
      </Encabezado>
      <Panel titulo="Datos">
        <Formulario accion={actualizarBancoAccion} className="max-w-xl space-y-4">
          <input type="hidden" name="id" value={id} />
          <Campo etiqueta="Nombre"><input name="nombre" defaultValue={b.nombre} required maxLength={80} className="campo" /></Campo>
          <Campo etiqueta="País (2 letras)"><input name="pais" defaultValue={b.pais} required maxLength={2} className="campo w-24 font-mono uppercase" /></Campo>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="activo" defaultChecked={b.activo} /> Activo</label>
          <p className="text-xs text-texto-2">El código no se cambia.</p>
          <BotonEnviar>Guardar</BotonEnviar>
        </Formulario>
      </Panel>
    </>
  );
}
