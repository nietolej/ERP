import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { estadoArranque } from '@/lib/apertura/apertura';
import { NOMBRE_ESTADO_CONTEO, ROLES_CUENTAN, ROLES_VEN_CONTEO, buscarConteos } from '@/lib/apertura/inventario';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { crearConteoAccion } from './acciones';

const TONO = { borrador: 'info', pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function ConteoInicialPage() {
  const u = await exigirRol(...ROLES_VEN_CONTEO);
  const db = await getDb();
  const [arranque, conteos] = await Promise.all([estadoArranque(db), buscarConteos(db, u)]);
  const abierta = Boolean(arranque.fecha) && !arranque.cerrada;
  const visibles = await almacenesVisibles(db, u);
  const { rows: libres } = abierta && tieneRol(u, ROLES_CUENTAN)
    ? await db.query<{ id: string; texto: string }>(
      `select a.id, a.codigo || ' · ' || a.nombre as texto from almacen a where a.activo and a.id = any($1::uuid[])
          and not exists (select 1 from apertura_inventario o where o.almacen_id = a.id and o.estado in ('borrador', 'pendiente', 'aprobado')) order by a.codigo`, [visibles])
    : { rows: [] };

  return (
    <>
      <Encabezado titulo="Conteo físico inicial de inventario"
        descripcion="Un conteo por almacén, con la toma física del día anterior al arranque. Almacén cuenta, Contabilidad fija el costo de cada línea en US$ y Gerencia, distinta de quienes lo registraron y valoraron, lo aprueba. Al aprobar entra el inventario inicial contra «Saldos de apertura».">
        <Link href="/configuracion/apertura" className="text-sm text-texto-2 hover:text-texto">← Apertura</Link>
      </Encabezado>
      {!arranque.fecha && <div className="mb-5"><Aviso tono="advertencia">Gerencia debe fijar primero la fecha de arranque (Configuración → Apertura).</Aviso></div>}
      {arranque.cerrada && <div className="mb-5"><Aviso tono="info">La apertura está cerrada: ya no se aceptan conteos iniciales.</Aviso></div>}
      <p className="mb-5 text-sm text-texto-2">Los productos se crean a medida que se cuentan (Maestros → Productos): solo los que existen físicamente. {arranque.fecha ? `Las entradas llevan la fecha de arranque, ${fecha(arranque.fecha)}.` : ''}</p>

      <Panel>
        <Tabla columnas={['N°', 'Almacén', { t: 'Líneas', derecha: true }, { t: 'Valor (US$)', derecha: true }, 'Registró', 'Estado']} vacio="Todavía no hay conteos iniciales.">
          {conteos.map((c) => (
            <tr key={c.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/inventario/apertura/${c.id}`} className="text-acento hover:underline">{c.numero}</Link></Celda>
              <Celda>{c.almacen}</Celda>
              <Celda derecha mono>{c.lineas}</Celda>
              <Celda derecha mono>{monto(c.total_usd)}</Celda>
              <Celda className="text-texto-2">{c.creador} · {c.creado}</Celda>
              <Celda><Etiqueta tono={TONO[c.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_CONTEO[c.estado] ?? c.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {libres.length > 0 && (
        <Panel titulo="Nuevo conteo" className="mt-5">
          <Formulario accion={crearConteoAccion} className="grid gap-4 sm:grid-cols-3 sm:items-end">
            <Campo etiqueta="Almacén (sin conteo todavía)">
              <select name="almacen_id" required defaultValue="" className="campo"><option value="" disabled>Seleccione…</option>{libres.map((a) => <option key={a.id} value={a.id}>{a.texto}</option>)}</select>
            </Campo>
            <Campo etiqueta="Observaciones (opcional)"><input name="observaciones" maxLength={300} className="campo" /></Campo>
            <BotonEnviar>Crear conteo</BotonEnviar>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
