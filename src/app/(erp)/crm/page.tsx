import Decimal from 'decimal.js';
import Link from 'next/link';
import { Celda, Encabezado, KpiCard, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_VEN_CRM, soloLoSuyo } from '@/lib/crm/comun';
import { agendaPendiente } from '@/lib/crm/contactos';
import { NOMBRE_TIPO_CASO, type TipoCaso } from '@/lib/crm/casos';
import { actividadesPorVendedor, casosPorTipo, clientesSinContacto, conversion, embudo } from '@/lib/crm/indicadores';
import { NOMBRE_ETAPA, type Etapa } from '@/lib/crm/oportunidades';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto } from '@/lib/formato';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Tablero del CRM (§6.5 regla 6): embudo, conversión, actividades, clientes sin contacto y resolución de casos. */
export default async function CrmPage({ searchParams }: { searchParams: Promise<{ desde?: string; hasta?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const sp = await searchParams;
  const hoy = hoyCaracas();
  const desde = sp.desde && FECHA.test(sp.desde) ? sp.desde : `${hoy.slice(0, 8)}01`;
  const hasta = sp.hasta && FECHA.test(sp.hasta) ? sp.hasta : hoy;
  const db = await getDb();
  const propio = soloLoSuyo(u);
  const [emb, conv, act, sin, casos, agenda] = await Promise.all([
    embudo(db, u), conversion(db, u, desde, hasta), actividadesPorVendedor(db, u, desde, hasta), clientesSinContacto(db, u, 50),
    propio ? Promise.resolve([]) : casosPorTipo(db, desde, hasta), agendaPendiente(db, u, 30),
  ]);

  const abiertas = emb.reduce((s, f) => s + f.oportunidades, 0);
  const total = emb.reduce((s, f) => s.plus(f.monto_usd), new Decimal(0));
  const ponderado = emb.reduce((s, f) => s.plus(f.ponderado_usd), new Decimal(0));
  const ganadas = conv.reduce((s, f) => s + f.ganadas, 0);
  const cerradas = conv.reduce((s, f) => s + f.ganadas + f.perdidas, 0);

  return (
    <>
      <Encabezado titulo="CRM y postventa"
        descripcion={propio ? 'Su embudo de oportunidades, sus actividades y sus clientes sin contacto.' : 'Embudo de oportunidades, conversión, actividades por vendedor, clientes sin contacto y casos de postventa.'}>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <label className="text-texto-2">Desde <input type="date" name="desde" defaultValue={desde} className="campo" /></label>
          <label className="text-texto-2">Hasta <input type="date" name="hasta" defaultValue={hasta} className="campo" /></label>
          <button className="rounded-lg border border-borde bg-white/5 px-3 py-2 hover:bg-white/10">Ver</button>
        </form>
      </Encabezado>

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard titulo="Oportunidades abiertas" valor={String(abiertas)} subtitulo={`US$ ${monto(total.toFixed(2))} estimados`} />
        <KpiCard titulo="Valor ponderado del embudo" valor={`US$ ${monto(ponderado.toFixed(2))}`} subtitulo="Monto × probabilidad de cada etapa" />
        <KpiCard titulo="Tasa de conversión" valor={cerradas ? `${(ganadas * 100 / cerradas).toFixed(1)} %` : '—'} subtitulo={`${ganadas} ganadas de ${cerradas} cerradas en el periodo`} />
        <KpiCard titulo="Clientes sin contacto" valor={String(sin.filas.length)} subtitulo={`Más de ${sin.dias} días sin actividades`} tono={sin.filas.length ? 'advertencia' : undefined} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Embudo por etapa">
          <Tabla columnas={['Etapa', { t: 'Oportunidades', derecha: true }, { t: 'Monto US$', derecha: true }, { t: 'Probabilidad', derecha: true }, { t: 'Ponderado US$', derecha: true }]}
            vacio="No hay oportunidades abiertas.">
            {emb.map((f) => (
              <tr key={f.etapa}>
                <Celda>{NOMBRE_ETAPA[f.etapa as Etapa]}</Celda>
                <Celda derecha mono>{f.oportunidades}</Celda>
                <Celda derecha mono>{monto(f.monto_usd)}</Celda>
                <Celda derecha mono>{Number(f.probabilidad_pct)} %</Celda>
                <Celda derecha mono>{monto(f.ponderado_usd)}</Celda>
              </tr>
            ))}
          </Tabla>
          <p className="mt-3 text-xs text-texto-2">Las probabilidades se cambian en Configuración → Parámetros de reportes e inventario.</p>
        </Panel>

        <Panel titulo="Conversión por vendedor (oportunidades cerradas en el periodo)">
          <Tabla columnas={['Vendedor', { t: 'Ganadas', derecha: true }, { t: 'Perdidas', derecha: true }, { t: 'Conversión', derecha: true }, { t: 'Ganado US$', derecha: true }, { t: 'Ciclo (días)', derecha: true }]}
            vacio="No se cerraron oportunidades en el periodo.">
            {conv.map((f) => (
              <tr key={f.vendedor}>
                <Celda>{f.vendedor}</Celda>
                <Celda derecha mono>{f.ganadas}</Celda>
                <Celda derecha mono>{f.perdidas}</Celda>
                <Celda derecha mono>{Number(f.tasa_pct).toFixed(1)} %</Celda>
                <Celda derecha mono>{monto(f.monto_ganado_usd)}</Celda>
                <Celda derecha mono>{f.ciclo_dias ?? '—'}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>

        <Panel titulo="Actividades por vendedor (en el periodo)">
          <Tabla columnas={['Vendedor', { t: 'Visitas', derecha: true }, { t: 'Llamadas', derecha: true }, { t: 'Mensajes', derecha: true }, { t: 'Correos', derecha: true }, { t: 'Tareas', derecha: true }, { t: 'Total', derecha: true }]}
            vacio="No hay actividades en el periodo.">
            {act.map((f) => (
              <tr key={f.usuario}>
                <Celda>{f.usuario}</Celda>
                <Celda derecha mono>{f.visitas}</Celda>
                <Celda derecha mono>{f.llamadas}</Celda>
                <Celda derecha mono>{f.mensajes}</Celda>
                <Celda derecha mono>{f.correos}</Celda>
                <Celda derecha mono>{f.tareas}</Celda>
                <Celda derecha mono>{f.total}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>

        {!propio && (
          <Panel titulo="Casos de postventa">
            <Tabla columnas={['Tipo', { t: 'Resueltos en el periodo', derecha: true }, { t: 'Días para resolver (promedio)', derecha: true }, { t: 'Pendientes hoy', derecha: true }]}>
              {casos.map((f) => (
                <tr key={f.tipo}>
                  <Celda>{NOMBRE_TIPO_CASO[f.tipo as TipoCaso]}</Celda>
                  <Celda derecha mono>{f.resueltos}</Celda>
                  <Celda derecha mono>{f.dias_resolucion ?? '—'}</Celda>
                  <Celda derecha mono>{f.pendientes}</Celda>
                </tr>
              ))}
            </Tabla>
          </Panel>
        )}

        <Panel titulo="Próximas acciones">
          <Tabla columnas={['Fecha', 'Cliente o prospecto', 'Acción']} vacio="No hay próximas acciones pendientes.">
            {agenda.map((a) => (
              <tr key={a.id}>
                <Celda className="text-texto-2">{a.proxima_fecha}</Celda>
                <Celda><Link href={`/crm/terceros/${a.tercero_id}`} className="text-acento hover:underline">{a.tercero}</Link></Celda>
                <Celda>{a.proxima_accion}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>

        <Panel titulo={`Clientes sin contacto en ${sin.dias} días o más`}>
          <Tabla columnas={['Cliente', 'Vendedor', 'Última actividad', { t: 'Días', derecha: true }]} vacio="Todos los clientes activos tienen contacto reciente.">
            {sin.filas.map((f) => (
              <tr key={f.cliente_id}>
                <Celda><Link href={`/crm/terceros/${f.cliente_id}`} className="text-acento hover:underline">{f.cliente}</Link></Celda>
                <Celda className="text-texto-2">{f.vendedor ?? '—'}</Celda>
                <Celda className="text-texto-2">{f.ultima_actividad ?? 'Nunca'}</Celda>
                <Celda derecha mono>{f.dias_sin_contacto}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      </div>
    </>
  );
}
