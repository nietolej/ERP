import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import {
  MODALIDADES, NOMBRE_MODALIDAD, ROLES_GESTIONAN_TRANSPORTISTAS, ROLES_VEN_TRANSPORTISTAS, buscarTransportistas, proveedoresDeServicio,
} from '@/lib/maestros/transportistas';
import { crearTransportistaAccion } from './acciones';

export default async function TransportistasPage() {
  const u = await exigirRol(...ROLES_VEN_TRANSPORTISTAS);
  const puedeCrear = tieneRol(u, [...ROLES_GESTIONAN_TRANSPORTISTAS]);
  const db = await getDb();
  const [transportistas, proveedores] = await Promise.all([buscarTransportistas(db), puedeCrear ? proveedoresDeServicio(db) : Promise.resolve([])]);

  return (
    <>
      <Encabezado titulo="Transportistas y vehículos"
        descripcion="Flota propia y proveedores de servicio de entrega (carga y encomienda). Un transportista de terceros es un proveedor de servicios ya aprobado y lleva sus tarifas." />
      <Panel>
        <Tabla columnas={['Código', 'Nombre', 'Modalidad', 'Proveedor', { t: 'Vehículos', derecha: true }, { t: 'Tarifas vigentes', derecha: true }, 'Estado']}
          vacio="Aún no hay transportistas. Registre primero la flota propia o un proveedor de servicios.">
          {transportistas.map((t) => (
            <tr key={t.id}>
              <Celda mono><Link href={`/maestros/transportistas/${t.id}`} className="text-acento hover:underline">{t.codigo}</Link></Celda>
              <Celda>{t.nombre}</Celda>
              <Celda className="text-texto-2">{NOMBRE_MODALIDAD[t.modalidad]}</Celda>
              <Celda className="text-texto-2">{t.proveedor ?? '—'}</Celda>
              <Celda derecha>{t.modalidad === 'encomienda' ? '—' : t.vehiculos}</Celda>
              <Celda derecha>{t.modalidad === 'flota_propia' ? '—' : t.tarifas_vigentes}</Celda>
              <Celda><Etiqueta tono={t.activo ? 'exito' : 'info'}>{t.activo ? 'activo' : 'inactivo'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {puedeCrear && (
        <Panel titulo="Nuevo transportista" className="mt-5">
          <Formulario accion={crearTransportistaAccion} className="grid gap-3 md:grid-cols-3 md:items-end">
            <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} placeholder="Reparto propio Barquisimeto" className="campo" /></Campo>
            <Campo etiqueta="Modalidad">
              <select name="modalidad" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {MODALIDADES.map((m) => <option key={m} value={m}>{NOMBRE_MODALIDAD[m]}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Proveedor de servicios" ayuda="Obligatorio para carga y encomienda. No aplica a la flota propia.">
              <select name="proveedor_id" defaultValue="" className="campo">
                <option value="">— Ninguno —</option>
                {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Teléfono de contacto"><input name="contacto_telefono" maxLength={40} className="campo" /></Campo>
            <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={250} className="campo" /></Campo>
            <div className="md:text-right"><BotonEnviar>Registrar transportista</BotonEnviar></div>
          </Formulario>
          {proveedores.length === 0 && (
            <p className="mt-3 text-sm text-texto-2">
              No hay proveedores de servicios aprobados. Para un transportista de terceros, registre el proveedor con tipo «Servicios» en Maestros → Proveedores y apruébelo.
            </p>
          )}
        </Panel>
      )}
    </>
  );
}
