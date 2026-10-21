import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas } from '@/lib/formato';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { NOMBRE_MODALIDAD, type Modalidad } from '@/lib/maestros/transportistas';
import { etiquetaTransporte } from '@/lib/ventas/presentacion';
import { ROLES_TRANSPORTE, ROLES_VEN_TRANSPORTE, buscarTransportes } from '@/lib/ventas/transportes';
import { crearTransporteAccion } from './acciones';

const FILTROS = [
  { valor: '', texto: 'Todos' },
  { valor: 'planificado', texto: 'Planificados' },
  { valor: 'cargado', texto: 'Cargados' },
  { valor: 'en_ruta', texto: 'En ruta' },
  { valor: 'entregado', texto: 'Entregados' },
  { valor: 'cerrado', texto: 'Cerrados' },
  { valor: 'anulado', texto: 'Anulados' },
] as const;

export default async function TransportesPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_TRANSPORTE);
  const { estado = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const db = await getDb();
  const opera = tieneRol(u, [...ROLES_TRANSPORTE]);
  const filas = await buscarTransportes(db, u, { estado: filtro });

  const [almacenes, transportistas, vehiculos] = opera ? await Promise.all([
    almacenesVisibles(db, u).then((ids) => db.query<{ id: string; codigo: string; nombre: string }>(
      'select id, codigo, nombre from almacen where activo and id = any($1::uuid[]) order by codigo', [ids])),
    db.query<{ id: string; nombre: string; modalidad: string }>('select id, nombre, modalidad from transportista where activo order by nombre'),
    db.query<{ id: string; etiqueta: string }>(
      `select v.id, t.nombre || ' · ' || v.placa || ' · ' || v.descripcion as etiqueta
         from vehiculo v join transportista t on t.id = v.transportista_id where v.activo and t.activo order by t.nombre, v.placa`),
  ]) : [null, null, null];

  return (
    <>
      <Encabezado titulo="Transportes y despachos"
        descripcion="Agrupe las notas de entrega listas en un transporte, cárguelo y siga cada entrega hasta cerrar el flete. Solo ve los almacenes que tiene asignados." />
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/ventas/transportes?estado=${f.valor}` : '/ventas/transportes'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Transporte', 'Fecha programada', 'Almacén', 'Transportista', { t: 'Paradas', derecha: true }, { t: 'Entregadas', derecha: true }, 'Estado']}
          vacio="No hay transportes con ese filtro.">
          {filas.map((t) => {
            const e = etiquetaTransporte(t.estado);
            return (
              <tr key={t.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/ventas/transportes/${t.id}`} className="text-acento hover:underline">{t.numero}</Link></Celda>
                <Celda>{fecha(t.fecha_programada)}</Celda>
                <Celda className="text-texto-2">{t.almacen}</Celda>
                <Celda>{t.transportista} <span className="text-xs text-texto-2">· {NOMBRE_MODALIDAD[t.modalidad as Modalidad]}</span></Celda>
                <Celda derecha mono>{t.paradas}</Celda>
                <Celda derecha mono>{t.entregadas}</Celda>
                <Celda><Etiqueta tono={e.tono}>{e.texto}</Etiqueta></Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>

      {opera && almacenes && transportistas && vehiculos && (
        <Panel titulo="Nuevo transporte" className="mt-5">
          {transportistas.rows.length === 0 ? (
            <p className="text-sm text-texto-2">
              Primero registre un transportista en <Link href="/maestros/transportistas" className="text-acento hover:underline">Maestros → Transportistas</Link>.
            </p>
          ) : (
            <Formulario accion={crearTransporteAccion} className="grid gap-3 md:grid-cols-3 md:items-end">
              <Campo etiqueta="Almacén de salida">
                <select name="almacen_id" required defaultValue={almacenes.rows.length === 1 ? almacenes.rows[0].id : ''} className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {almacenes.rows.map((a) => <option key={a.id} value={a.id}>{a.codigo} · {a.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Transportista">
                <select name="transportista_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {transportistas.rows.map((t) => <option key={t.id} value={t.id}>{t.nombre} ({NOMBRE_MODALIDAD[t.modalidad as Modalidad]})</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Vehículo" ayuda="Debe pertenecer al transportista. No aplica a la encomienda.">
                <select name="vehiculo_id" defaultValue="" className="campo">
                  <option value="">— Sin vehículo —</option>
                  {vehiculos.rows.map((v) => <option key={v.id} value={v.id}>{v.etiqueta}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Chofer"><input name="chofer" maxLength={80} className="campo" /></Campo>
              <Campo etiqueta="Fecha programada"><input type="date" name="fecha_programada" required defaultValue={hoyCaracas()} min={hoyCaracas()} className="campo" /></Campo>
              <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={250} className="campo" /></Campo>
              <div className="md:col-span-3 md:text-right"><BotonEnviar>Crear transporte</BotonEnviar></div>
            </Formulario>
          )}
        </Panel>
      )}
    </>
  );
}
