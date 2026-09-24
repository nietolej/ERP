import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { FormularioVendedor } from '@/components/formulario-vendedor';
import { Encabezado, Etiqueta, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { actualizarVendedorAccion, cambiarEstadoVendedorAccion } from '../acciones';
import { TIPOS, UUID, opcionesVendedor } from '../datos';

export default async function VendedorPage({ params }: { params: Promise<{ id: string }> }) {
  await exigirRol('gerencia', 'supervisor_ventas');
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();

  const { rows } = await db.query<{
    codigo: string; nombre: string; tipo: string; sucursal_id: string | null; usuario_id: string | null;
    rif: string | null; estado: string; clientes: number;
  }>(
    `select v.codigo, v.nombre, v.tipo, v.sucursal_id, v.usuario_id, t.rif, v.estado,
            (select count(*)::int from cliente c where c.vendedor_id = v.id) as clientes
       from vendedor v left join tercero t on t.id = v.tercero_id where v.id = $1`, [id]);
  const v = rows[0];
  if (!v) notFound();
  const { sucursales, usuarios } = await opcionesVendedor(db, id);

  return (
    <>
      <Encabezado titulo={`${v.codigo} · ${v.nombre}`} descripcion={`${v.clientes} cliente(s) asignado(s).`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={v.estado === 'activo' ? 'exito' : 'info'}>{v.estado}</Etiqueta>
          <Link href="/maestros/vendedores" className="text-sm text-texto-2 hover:text-texto">← Vendedores</Link>
        </div>
      </Encabezado>
      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <Panel titulo="Datos del vendedor">
          <FormularioVendedor accion={actualizarVendedorAccion} sucursales={sucursales} usuarios={usuarios} tipos={TIPOS}
            inicial={{ id, nombre: v.nombre, tipo: v.tipo, sucursalId: v.sucursal_id ?? '', usuarioId: v.usuario_id ?? '', rif: v.rif ?? '' }} />
        </Panel>
        <Panel titulo="Estado">
          <p className="mb-3 text-sm text-texto-2">
            Un vendedor no se borra: se inactiva. Sus clientes conservan la asignación hasta que se les asigne otro vendedor.
          </p>
          <Formulario accion={cambiarEstadoVendedorAccion}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="estado" value={v.estado === 'activo' ? 'inactivo' : 'activo'} />
            <BotonEnviar variante="secundario">{v.estado === 'activo' ? 'Inactivar' : 'Reactivar'}</BotonEnviar>
          </Formulario>
        </Panel>
      </div>
    </>
  );
}
