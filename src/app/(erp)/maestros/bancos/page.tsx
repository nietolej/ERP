import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_ADMIN_BANCOS, ROLES_VEN_BANCOS } from '@/lib/maestros/bancos';
import { crearBancoAccion } from './acciones';

export default async function BancosPage() {
  const u = await exigirRol(...ROLES_VEN_BANCOS);
  const puedeAdministrar = tieneRol(u, ROLES_ADMIN_BANCOS);
  const db = await getDb();
  const { rows } = await db.query<{ id: string; codigo: string; nombre: string; pais: string; activo: boolean }>(
    'select id, codigo, nombre, pais, activo from banco order by codigo');

  return (
    <>
      <Encabezado titulo="Bancos"
        descripcion="Catálogo de instituciones financieras. Un banco no se borra: se inactiva. Las cuentas bancarias se registran en la Fase 3." />
      <Panel>
        <Tabla columnas={['Código', 'Nombre', 'País', 'Estado']} vacio="Aún no hay bancos registrados.">
          {rows.map((b) => (
            <tr key={b.id}>
              <Celda mono>{puedeAdministrar ? <Link href={`/maestros/bancos/${b.id}`} className="text-acento hover:underline">{b.codigo}</Link> : b.codigo}</Celda>
              <Celda>{b.nombre}</Celda>
              <Celda className="text-texto-2">{b.pais}</Celda>
              <Celda><Etiqueta tono={b.activo ? 'exito' : 'info'}>{b.activo ? 'activo' : 'inactivo'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
      {puedeAdministrar && (
        <Panel titulo="Nuevo banco" className="mt-5">
          <Formulario accion={crearBancoAccion} className="grid gap-3 md:grid-cols-[8rem_1fr_6rem] md:items-end">
            <Campo etiqueta="Código"><input name="codigo" required maxLength={10} placeholder="0134" className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} className="campo" /></Campo>
            <Campo etiqueta="País"><input name="pais" required maxLength={2} defaultValue="VE" className="campo font-mono uppercase" /></Campo>
            <div className="md:col-span-3 md:text-right"><BotonEnviar>Registrar banco</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
