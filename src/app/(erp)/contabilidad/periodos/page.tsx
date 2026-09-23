import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, fechaHora, hoyCaracas } from '@/lib/formato';
import { cambiarEstadoPeriodo, crearPeriodosDelAnio } from '../acciones';

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre', 'Cierre del ejercicio'];
const TONO = { abierto: 'exito', cerrado: 'advertencia', bloqueado: 'peligro' } as const;

export default async function PeriodosPage({ searchParams }: { searchParams: Promise<{ anio?: string }> }) {
  const u = await exigirRol('contabilidad', 'gerencia', 'auditor');
  const puedeCambiar = tieneRol(u, ['contabilidad']);
  const anioActual = Number(hoyCaracas().slice(0, 4));
  const anio = Number((await searchParams).anio) || anioActual;
  const db = await getDb();

  const anios = (await db.query<{ anio: number }>('select distinct anio from periodo_contable order by anio')).rows.map((r) => Number(r.anio));
  const { rows } = await db.query<{
    id: string; mes: number; inicio: string; fin: string; estado: keyof typeof TONO;
    cambiado_at: Date | null; nombre: string | null; asientos: string;
  }>(
    `select p.id, p.mes, p.inicio, p.fin, p.estado, p.cambiado_at, us.nombre,
            (select count(*) from asiento a where a.periodo_id = p.id and a.estado = 'contabilizado') as asientos
       from periodo_contable p left join usuario us on us.id = p.cambiado_por
      where p.anio = $1 order by p.mes`, [anio]);

  return (
    <>
      <Encabezado titulo="Periodos contables" descripcion="Abierto acepta todo · Cerrado solo reversos y cierre · Bloqueado nada, y no se reabre (§3.2).">
        <div className="flex flex-wrap gap-2">
          {[...new Set([...anios, anioActual])].sort().map((a) => (
            <Link key={a} href={`?anio=${a}`}
              className={`rounded-md px-3 py-1 text-sm font-semibold ${a === anio ? 'bg-acento text-white' : 'border border-borde text-texto-2'}`}>{a}</Link>
          ))}
        </div>
      </Encabezado>

      {rows.length === 0 ? (
        <Panel>
          <p className="mb-4 text-sm text-texto-2">No hay periodos creados para {anio}.</p>
          {puedeCambiar && (
            <Formulario accion={crearPeriodosDelAnio} className="flex items-end gap-3">
              <Campo etiqueta="Año"><input name="anio" defaultValue={anio} className="campo w-28" /></Campo>
              <BotonEnviar>Crear los 13 periodos</BotonEnviar>
            </Formulario>
          )}
        </Panel>
      ) : (
        <Panel>
          <Tabla columnas={['Periodo', 'Desde', 'Hasta', { t: 'Asientos', derecha: true }, 'Estado', 'Último cambio', puedeCambiar ? 'Acciones' : '']}>
            {rows.map((p) => (
              <tr key={p.id}>
                <Celda>{MESES[p.mes]}</Celda>
                <Celda>{fecha(p.inicio)}</Celda>
                <Celda>{fecha(p.fin)}</Celda>
                <Celda derecha>{p.asientos}</Celda>
                <Celda><Etiqueta tono={TONO[p.estado]}>{p.estado}</Etiqueta></Celda>
                <Celda className="text-texto-2">{p.nombre ? `${p.nombre} · ${fechaHora(p.cambiado_at)}` : '—'}</Celda>
                <Celda>
                  {puedeCambiar && p.estado !== 'bloqueado' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Formulario accion={cambiarEstadoPeriodo}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="estado" value={p.estado === 'abierto' ? 'cerrado' : 'abierto'} />
                        <BotonEnviar variante="secundario">{p.estado === 'abierto' ? 'Cerrar' : 'Reabrir'}</BotonEnviar>
                      </Formulario>
                      {p.estado === 'cerrado' && (
                        <Formulario accion={cambiarEstadoPeriodo} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={p.id} />
                          <input type="hidden" name="estado" value="bloqueado" />
                          <label className="flex items-center gap-1 text-xs text-texto-2"><input type="checkbox" name="confirmo" /> irreversible</label>
                          <BotonEnviar variante="peligro">Bloquear</BotonEnviar>
                        </Formulario>
                      )}
                    </div>
                  )}
                </Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      )}
    </>
  );
}
