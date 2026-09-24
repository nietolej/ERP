import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { cambiarEstadoConceptoIslr, crearConceptoIslr } from './acciones';

export default async function ConceptosIslrPage() {
  const u = await exigirRol('contabilidad', 'jefe_contabilidad', 'compras', 'gerencia', 'auditor');
  const esContador = tieneRol(u, ['contabilidad']);
  const db = await getDb();
  const { rows } = await db.query<{ id: string; codigo: string; descripcion: string; activo: boolean; proveedores: number }>(
    `select c.id, c.codigo, c.descripcion, c.activo,
            (select count(*)::int from proveedor p where p.concepto_islr_id = c.id) as proveedores
       from concepto_islr c order by c.codigo`);

  return (
    <>
      <Encabezado titulo="Conceptos de ISLR" descripcion="Catálogo de conceptos del Decreto 1.808 que se asignan a los proveedores." />
      <div className="mb-5">
        <Aviso tono="info">
          Aquí solo se registra el catálogo. Los porcentajes, mínimos y sustraendos de cada concepto se cargan con su vigencia
          cuando se implemente la retención de ISLR (Fases 3 y 4). No se precargan para no escribir normativa en el sistema.
        </Aviso>
      </div>
      <Panel titulo="Conceptos">
        <Tabla columnas={['Código', 'Descripción', { t: 'Proveedores', derecha: true }, 'Estado', esContador ? 'Acción' : '']}
          vacio="Aún no hay conceptos registrados.">
          {rows.map((c) => (
            <tr key={c.id}>
              <Celda mono>{c.codigo}</Celda>
              <Celda>{c.descripcion}</Celda>
              <Celda derecha>{c.proveedores}</Celda>
              <Celda><Etiqueta tono={c.activo ? 'exito' : 'info'}>{c.activo ? 'activo' : 'inactivo'}</Etiqueta></Celda>
              <Celda>
                {esContador && (
                  <Formulario accion={cambiarEstadoConceptoIslr}>
                    <input type="hidden" name="id" value={c.id} />
                    <BotonEnviar variante="secundario">{c.activo ? 'Inactivar' : 'Reactivar'}</BotonEnviar>
                  </Formulario>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
      {esContador && (
        <Panel titulo="Registrar concepto" className="mt-5">
          <Formulario accion={crearConceptoIslr} className="grid gap-3 md:grid-cols-[10rem_1fr_auto] md:items-end">
            <Campo etiqueta="Código"><input name="codigo" required maxLength={10} className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="Descripción"><input name="descripcion" required maxLength={200} className="campo" /></Campo>
            <div><BotonEnviar>Registrar</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
