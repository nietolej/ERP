import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fechaHora, hoyCaracas, monto } from '@/lib/formato';
import { metaGlobal, NOMBRE_TIPO_META, ROLES_CARGAN_METAS, ROLES_VEN_METAS, TIPOS_META, type TipoMeta } from '@/lib/maestros/metas';
import { cargarExcelAccion, guardarManualAccion } from './acciones';

const FILAS_NUEVAS = 10;
const MAX_VIGENTES = 300;
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const TONO = { pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function MetasPage({ searchParams }: { searchParams: Promise<{ anio?: string; tipo?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_METAS);
  const puedeCargar = tieneRol(u, ROLES_CARGAN_METAS);
  const sp = await searchParams;
  const anioActual = Number(hoyCaracas().slice(0, 4));
  const anio = /^\d{4}$/.test(sp.anio ?? '') ? Number(sp.anio) : anioActual;
  const tipo = (TIPOS_META as readonly string[]).includes(sp.tipo ?? '') ? (sp.tipo as TipoMeta) : null;

  const db = await getDb();
  const [global, pendientes, vigentes, historial] = await Promise.all([
    metaGlobal(db, anio),
    db.query<{ id: string; version: number; origen: string; archivo: string | null; filas: number; creador: string; created_at: string }>(
      `select l.id, l.version, l.origen, l.archivo, l.created_at, u.nombre as creador,
              (select count(*)::int from meta_venta m where m.lote_id = l.id) as filas
         from meta_lote l join usuario u on u.id = l.creado_por
        where l.estado = 'pendiente' order by l.version`),
    db.query<{ tipo: TipoMeta; entidad_id: string | null; entidad: string; anio: number; mes: number | null; monto_usd: string; version: number }>(
      `select tipo, entidad_id, entidad, anio, mes, monto_usd, version from vw_meta_periodo
        where anio = $1 and ($2::text is null or tipo = $2)
        order by tipo, entidad, mes nulls first limit ${MAX_VIGENTES}`, [anio, tipo]),
    db.query<{ id: string; version: number; origen: string; estado: 'pendiente' | 'aprobado' | 'rechazado'; creador: string; created_at: string; filas: number }>(
      `select l.id, l.version, l.origen, l.estado, l.created_at, u.nombre as creador,
              (select count(*)::int from meta_venta m where m.lote_id = l.id) as filas
         from meta_lote l join usuario u on u.id = l.creado_por order by l.version desc limit 20`),
  ]);

  return (
    <>
      <Encabezado titulo="Configuración de Metas"
        descripcion="Metas de venta en USD por cliente, vendedor, producto, grupo o global. Cada carga es un lote con versión que Gerencia aprueba; la meta vigente es la del último lote aprobado." />

      <Panel titulo="Consulta">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Campo etiqueta="Año"><input name="anio" defaultValue={anio} inputMode="numeric" maxLength={4} className="campo w-24" /></Campo>
          <Campo etiqueta="Tipo">
            <select name="tipo" defaultValue={tipo ?? ''} className="campo">
              <option value="">Todos</option>
              {TIPOS_META.map((t) => <option key={t} value={t}>{NOMBRE_TIPO_META[t]}</option>)}
            </select>
          </Campo>
          <button type="submit" className="rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">Ver</button>
        </form>
        <div className="mt-4">
          {global ? (
            <Aviso tono="info">
              Meta global {anio}: <strong>{monto(global.monto, '$')}</strong>
              {global.origen === 'suma_vendedores' && ' — no hay una fila GLOBAL aprobada: es la suma de las metas de los vendedores.'}
            </Aviso>
          ) : (
            <Aviso tono="advertencia">Sin meta cargada para el año {anio}: no hay meta global ni metas de vendedores aprobadas.</Aviso>
          )}
        </div>
      </Panel>

      {pendientes.rows.length > 0 && (
        <Panel titulo="Lotes pendientes de aprobación" className="mt-5">
          <Tabla columnas={['Versión', 'Origen', 'Filas', 'Cargó', 'Fecha']}>
            {pendientes.rows.map((l) => (
              <tr key={l.id}>
                <Celda mono><Link href={`/metas/lote/${l.id}`} className="text-acento hover:underline">v{l.version}</Link></Celda>
                <Celda className="text-texto-2">{l.origen === 'excel' ? `Excel${l.archivo ? ` · ${l.archivo}` : ''}` : 'Manual'}</Celda>
                <Celda derecha>{l.filas}</Celda>
                <Celda>{l.creador}</Celda>
                <Celda className="text-texto-2">{fechaHora(l.created_at)}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      )}

      <Panel titulo={puedeCargar ? `Metas vigentes ${anio} y captura manual` : `Metas vigentes ${anio}`} className="mt-5">
        {puedeCargar ? (
          <Formulario accion={guardarManualAccion} className="space-y-5">
            <input type="hidden" name="e_n" value={vigentes.rows.length} />
            <Tabla columnas={['Tipo', 'Entidad', 'Año', 'Mes', 'Versión', { t: 'Meta vigente (USD)', derecha: true }, { t: 'Nueva meta (USD)', derecha: true }]}
              vacio="No hay metas aprobadas para este año.">
              {vigentes.rows.map((m, i) => (
                <tr key={`${m.tipo}${m.entidad_id}${m.mes}`}>
                  <Celda>{NOMBRE_TIPO_META[m.tipo]}</Celda>
                  <Celda>{m.entidad}</Celda>
                  <Celda mono>{m.anio}</Celda>
                  <Celda>{m.mes ? MESES[m.mes - 1] : 'Anual'}</Celda>
                  <Celda mono>v{m.version}</Celda>
                  <Celda derecha mono>{monto(m.monto_usd, '$')}</Celda>
                  <Celda derecha>
                    <input type="hidden" name={`e_clave_${i}`} value={`${m.tipo}|${m.entidad_id ?? ''}|${m.anio}|${m.mes ?? ''}`} />
                    <input type="hidden" name={`e_orig_${i}`} value={m.monto_usd} />
                    <input name={`e_monto_${i}`} defaultValue={m.monto_usd} inputMode="decimal" aria-label={`Nueva meta de ${m.entidad}`} className="campo w-32 text-right font-mono" />
                  </Celda>
                </tr>
              ))}
            </Tabla>
            {vigentes.rows.length === MAX_VIGENTES && <p className="text-xs text-texto-2">Se muestran las primeras {MAX_VIGENTES}. Filtre por tipo para ver el resto.</p>}

            <div>
              <h3 className="mb-2 text-sm font-semibold">Metas nuevas</h3>
              <p className="mb-2 text-xs text-texto-2">Código del ERP (o RIF, si es cliente). El mes vacío es una meta anual. La meta global no lleva código. Las filas vacías se ignoran.</p>
              <div className="space-y-2">
                {Array.from({ length: FILAS_NUEVAS }, (_, i) => (
                  <div key={i} className="grid gap-2 md:grid-cols-[9rem_1fr_6rem_6rem_9rem]">
                    <select name={`n_tipo_${i}`} defaultValue="vendedor" aria-label="Tipo" className="campo">
                      {TIPOS_META.map((t) => <option key={t} value={t}>{NOMBRE_TIPO_META[t]}</option>)}
                    </select>
                    <input name={`n_codigo_${i}`} placeholder="Código o RIF" maxLength={30} aria-label="Código" className="campo font-mono" />
                    <input name={`n_anio_${i}`} defaultValue={anio} inputMode="numeric" maxLength={4} aria-label="Año" className="campo font-mono" />
                    <input name={`n_mes_${i}`} placeholder="Mes" inputMode="numeric" maxLength={2} aria-label="Mes" className="campo font-mono" />
                    <input name={`n_monto_${i}`} placeholder="Meta USD" inputMode="decimal" aria-label="Meta en USD" className="campo text-right font-mono" />
                  </div>
                ))}
              </div>
            </div>
            <BotonEnviar>Guardar como lote pendiente</BotonEnviar>
          </Formulario>
        ) : (
          <Tabla columnas={['Tipo', 'Entidad', 'Año', 'Mes', 'Versión', { t: 'Meta vigente (USD)', derecha: true }]} vacio="No hay metas aprobadas para este año.">
            {vigentes.rows.map((m) => (
              <tr key={`${m.tipo}${m.entidad_id}${m.mes}`}>
                <Celda>{NOMBRE_TIPO_META[m.tipo]}</Celda>
                <Celda>{m.entidad}</Celda>
                <Celda mono>{m.anio}</Celda>
                <Celda>{m.mes ? MESES[m.mes - 1] : 'Anual'}</Celda>
                <Celda mono>v{m.version}</Celda>
                <Celda derecha mono>{monto(m.monto_usd, '$')}</Celda>
              </tr>
            ))}
          </Tabla>
        )}
      </Panel>

      {puedeCargar && (
        <Panel titulo="Carga por Excel" className="mt-5">
          <Formulario accion={cargarExcelAccion} className="space-y-4">
            <Campo etiqueta="Archivo .xlsx (hasta 2 MB)" ayuda="Se valida fila por fila. Si una fila tiene error no se guarda nada y se informan las filas con problema.">
              <input type="file" name="archivo" accept=".xlsx" required className="campo" />
            </Campo>
            <BotonEnviar>Cargar como lote pendiente</BotonEnviar>
          </Formulario>
          <h3 className="mb-2 mt-6 text-sm font-semibold">Estructura del archivo</h3>
          <p className="mb-2 text-xs text-texto-2">La primera fila lleva los encabezados. Se lee la primera hoja.</p>
          <Tabla columnas={['Columna', 'Obligatoria', 'Contenido', 'Ejemplo']}>
            <tr><Celda mono>TIPO</Celda><Celda>Sí</Celda><Celda>CLIENTE, VENDEDOR, PRODUCTO, GRUPO o GLOBAL</Celda><Celda mono>VENDEDOR</Celda></tr>
            <tr><Celda mono>CODIGO</Celda><Celda>Sí</Celda><Celda>Código del ERP; para clientes, también el RIF. En GLOBAL puede ir vacío</Celda><Celda mono>V001</Celda></tr>
            <tr><Celda mono>ANIO</Celda><Celda>Sí</Celda><Celda>Año de la meta</Celda><Celda mono>{anioActual}</Celda></tr>
            <tr><Celda mono>META_VENTA</Celda><Celda>Sí</Celda><Celda>Meta en USD, no negativa, con hasta 2 decimales</Celda><Celda mono>15000</Celda></tr>
            <tr><Celda mono>MES</Celda><Celda>No</Celda><Celda>1 a 12. Vacío = meta anual</Celda><Celda mono>3</Celda></tr>
          </Tabla>
        </Panel>
      )}

      <Panel titulo="Historial de lotes" className="mt-5">
        <Tabla columnas={['Versión', 'Origen', 'Filas', 'Cargó', 'Fecha', 'Estado']} vacio="Aún no se ha cargado ninguna meta.">
          {historial.rows.map((l) => (
            <tr key={l.id}>
              <Celda mono><Link href={`/metas/lote/${l.id}`} className="text-acento hover:underline">v{l.version}</Link></Celda>
              <Celda className="text-texto-2">{l.origen === 'excel' ? 'Excel' : 'Manual'}</Celda>
              <Celda derecha>{l.filas}</Celda>
              <Celda>{l.creador}</Celda>
              <Celda className="text-texto-2">{fechaHora(l.created_at)}</Celda>
              <Celda><Etiqueta tono={TONO[l.estado]}>{l.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
