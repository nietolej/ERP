import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_PLANES, ROLES_VEN_TODO_COMISIONES, asignaciones, listarPlanes } from '@/lib/comisiones/comisiones';
import { getDb } from '@/lib/db';
import { fecha } from '@/lib/formato';
import { asignarPlanAccion, crearPlanAccion } from '../acciones';

const TONO = { borrador: 'info', pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function PlanesPage() {
  const u = await exigirRol(...ROLES_VEN_TODO_COMISIONES);
  const db = await getDb();
  const puede = tieneRol(u, ROLES_PLANES);
  const [planes, asig, grupos, marcas, vendedores] = await Promise.all([
    listarPlanes(db), asignaciones(db),
    db.query<{ id: string; nombre: string }>('select id, nombre from grupo_producto where activo order by nombre'),
    db.query<{ id: string; nombre: string }>('select id, nombre from marca where activo order by nombre'),
    db.query<{ id: string; codigo: string; nombre: string }>(`select id, codigo, nombre from vendedor where estado = 'activo' and tipo in ('interno', 'externo') order by codigo`),
  ]);
  const aprobados = planes.filter((p) => p.estado === 'aprobado');

  return (
    <>
      <Encabezado titulo="Planes de comisión" descripcion="Un plan es un conjunto de reglas por grupo de producto y marca, con su porcentaje sobre lo cobrado. Lo aprueba Gerencia y, aprobado, no se edita: un cambio es un plan nuevo.">
        <Link href="/comisiones" className="text-sm text-texto-2 hover:text-texto">← Estado de comisiones</Link>
      </Encabezado>
      <Panel titulo="Planes" className="mb-5">
        <Tabla columnas={['Plan', 'Estado', { t: 'Reglas', derecha: true }, { t: 'Vendedores vigentes', derecha: true }, 'Creado por']} vacio="Todavía no hay planes.">
          {planes.map((p) => (
            <tr key={p.id}>
              <Celda><Link href={`/comisiones/planes/${p.id}`} className="text-acento hover:underline">{p.nombre}</Link></Celda>
              <Celda><Etiqueta tono={TONO[p.estado as keyof typeof TONO] ?? 'info'}>{p.estado}</Etiqueta></Celda>
              <Celda derecha>{p.reglas}</Celda><Celda derecha>{p.vendedores}</Celda><Celda>{p.creador}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <Panel titulo="Asignación a vendedores" className="mb-5">
        <Tabla columnas={['Vendedor', 'Plan', 'Desde', 'Hasta']} vacio="Ningún vendedor tiene plan asignado: sin plan en la fecha de la factura no hay comisión.">
          {asig.map((a) => (
            <tr key={a.id}><Celda>{a.codigo} · {a.vendedor}</Celda><Celda>{a.plan}</Celda><Celda>{fecha(a.desde)}</Celda><Celda>{a.hasta ? fecha(a.hasta) : 'vigente'}</Celda></tr>
          ))}
        </Tabla>
        {puede && aprobados.length > 0 && (
          <Formulario accion={asignarPlanAccion} className="mt-4 flex flex-wrap items-end gap-3">
            <Campo etiqueta="Vendedor"><select name="vendedor_id" required className="campo">{vendedores.rows.map((v) => <option key={v.id} value={v.id}>{v.codigo} · {v.nombre}</option>)}</select></Campo>
            <Campo etiqueta="Plan aprobado"><select name="plan_id" required className="campo">{aprobados.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
            <Campo etiqueta="Rige desde" ayuda="Cierra el plan anterior el día previo."><input type="date" name="desde" required className="campo" /></Campo>
            <BotonEnviar>Asignar</BotonEnviar>
          </Formulario>
        )}
      </Panel>

      {puede && (
        <Panel titulo="Nuevo plan">
          <Formulario accion={crearPlanAccion} className="space-y-4">
            <Campo etiqueta="Nombre del plan"><input name="nombre" required minLength={3} maxLength={80} className="campo w-96" /></Campo>
            <p className="text-sm text-texto-2">Cada fila es una regla. Déjela en blanco si no la usa. Un grupo y una marca vacíos son la regla general; se aplica la regla más específica de cada línea de la factura.</p>
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex flex-wrap items-end gap-3">
                  <Campo etiqueta={i === 1 ? 'Grupo de producto' : ''}><select name={`grupo_${i}`} className="campo w-56"><option value="">Todos los grupos</option>{grupos.rows.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}</select></Campo>
                  <Campo etiqueta={i === 1 ? 'Marca' : ''}><select name={`marca_${i}`} className="campo w-56"><option value="">Todas las marcas</option>{marcas.rows.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</select></Campo>
                  <Campo etiqueta={i === 1 ? 'Porcentaje sobre lo cobrado' : ''}><input name={`pct_${i}`} inputMode="decimal" placeholder="Ej.: 2.5" className="campo w-32" /></Campo>
                </div>
              ))}
            </div>
            <BotonEnviar>Crear plan (borrador)</BotonEnviar>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
