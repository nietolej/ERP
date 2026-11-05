import Link from 'next/link';
import { Aviso, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import {
  ROLES_VEN_ESTADOS, estadosDelMes, flujoEfectivoDelMes, rangoDeMes, type CambiosPatrimonio, type FlujoEfectivo, type Grupo, type Moneda, type Par, type Resultados, type Situacion,
} from '@/lib/contabilidad/estados';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';

const TABS = [
  { id: 'situacion', texto: 'Estado de situación financiera' },
  { id: 'resultados', texto: 'Estado de resultados' },
  { id: 'patrimonio', texto: 'Cambios en el patrimonio' },
  { id: 'flujo', texto: 'Flujo de efectivo' },
] as const;

const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const etiquetaMes = (anio: number, mes: number) => `${NOMBRE_MES[mes - 1]} ${anio}`;
const mon = (p: Par, m: Moneda) => (m === 'ves' ? p.ves : p.usd);
const fmt = (p: Par, m: Moneda) => monto(mon(p, m).toFixed(2));

function mesPasado(): string {
  const c = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  c.setDate(1);
  c.setMonth(c.getMonth() - 1);
  return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`;
}

/** Filas de un estado con varias columnas comparativas: grupos con sus líneas y totales. */
function Cuerpo({ cols, m, children }: { cols: string[]; m: Moneda; children: React.ReactNode }) {
  return (
    <Tabla columnas={['Cuenta', ...cols.map((c) => ({ t: `${c} (${m === 'ves' ? 'Bs.' : 'US$'})`, derecha: true }))]}>
      {children}
    </Tabla>
  );
}

function FilaGrupo({ g, m, n }: { g: Grupo[]; m: Moneda; n: number }) {
  // g: el mismo grupo en cada columna (misma estructura de cuentas puede variar: se unen por código).
  const codigos = new Map<string, string>();
  for (const x of g) for (const l of x.lineas) if (!codigos.has(`${l.codigo}|${l.nombre}`)) codigos.set(`${l.codigo}|${l.nombre}`, l.nombre);
  const claves = [...codigos.keys()];
  return (
    <>
      <tr className="bg-white/[0.03]"><Celda className="font-semibold">{g[0].titulo}</Celda>{Array.from({ length: n }, (_, i) => <Celda key={i}>{''}</Celda>)}</tr>
      {claves.map((k) => {
        const [codigo, nombre] = k.split('|');
        return (
          <tr key={k}>
            <Celda className="pl-6"><span className="font-mono text-xs text-texto-2">{codigo}</span> {nombre}</Celda>
            {g.map((x, i) => { const l = x.lineas.find((y) => `${y.codigo}|${y.nombre}` === k); return <Celda key={i} derecha mono>{l ? fmt(l.valor, m) : '—'}</Celda>; })}
          </tr>
        );
      })}
      <tr className="font-semibold"><Celda className="pl-6">Total {g[0].titulo.toLowerCase()}</Celda>{g.map((x, i) => <Celda key={i} derecha mono>{fmt(x.total, m)}</Celda>)}</tr>
    </>
  );
}

function FilaTotal({ titulo, valores, m, fuerte = true }: { titulo: string; valores: Par[]; m: Moneda; fuerte?: boolean }) {
  return <tr className={fuerte ? 'border-t border-borde font-semibold' : ''}><Celda>{titulo}</Celda>{valores.map((v, i) => <Celda key={i} derecha mono>{fmt(v, m)}</Celda>)}</tr>;
}

function Situacion3({ s, m, cols }: { s: Situacion[]; m: Moneda; cols: string[] }) {
  return (
    <Cuerpo cols={cols} m={m}>
      <FilaGrupo g={s.map((x) => x.activoCorriente)} m={m} n={s.length} />
      <FilaGrupo g={s.map((x) => x.activoNoCorriente)} m={m} n={s.length} />
      <FilaTotal titulo="TOTAL ACTIVO" valores={s.map((x) => x.totalActivo)} m={m} />
      <FilaGrupo g={s.map((x) => x.pasivoCorriente)} m={m} n={s.length} />
      {s.some((x) => x.pasivoNoCorriente.lineas.length) && <FilaGrupo g={s.map((x) => x.pasivoNoCorriente)} m={m} n={s.length} />}
      <FilaTotal titulo="TOTAL PASIVO" valores={s.map((x) => x.totalPasivo)} m={m} />
      <FilaGrupo g={s.map((x) => x.patrimonio)} m={m} n={s.length} />
      <FilaTotal titulo="TOTAL PASIVO Y PATRIMONIO" valores={s.map((x) => x.totalPasivoPatrimonio)} m={m} />
      <tr><Celda className="text-xs text-texto-2">Diferencia (activo − pasivo y patrimonio)</Celda>{s.map((x, i) => <Celda key={i} derecha mono className={x.cuadra ? 'text-texto-2' : 'text-peligro'}>{fmt(x.diferencia, m)}</Celda>)}</tr>
    </Cuerpo>
  );
}

function Resultados3({ r, m, cols }: { r: Resultados[]; m: Moneda; cols: string[] }) {
  const n = r.length;
  const vacio = (g: (x: Resultados) => Grupo) => r.every((x) => g(x).lineas.length === 0);
  const sec = (g: (x: Resultados) => Grupo) => (vacio(g) ? null : <FilaGrupo g={r.map(g)} m={m} n={n} />);
  return (
    <Cuerpo cols={cols} m={m}>
      <FilaGrupo g={r.map((x) => x.ventasBrutas)} m={m} n={n} />
      {sec((x) => x.devoluciones)}
      {sec((x) => x.descuentos)}
      <FilaTotal titulo="VENTAS NETAS" valores={r.map((x) => x.ventasNetas)} m={m} />
      {sec((x) => x.costoVentas)}
      <FilaTotal titulo="UTILIDAD BRUTA" valores={r.map((x) => x.utilidadBruta)} m={m} />
      <tr><Celda className="text-xs text-texto-2">Margen bruto</Celda>{r.map((x, i) => <Celda key={i} derecha mono className="text-texto-2">{x.margenBrutoPct === null ? '—' : `${x.margenBrutoPct} %`}</Celda>)}</tr>
      {sec((x) => x.gastosVenta)}
      {sec((x) => x.gastosAdministracion)}
      {sec((x) => x.otrosGastos)}
      <FilaTotal titulo="UTILIDAD OPERATIVA (EBIT)" valores={r.map((x) => x.utilidadOperativa)} m={m} />
      {sec((x) => x.diferencialCambiario)}
      {sec((x) => x.gastosFinancieros)}
      {sec((x) => x.otrosIngresos)}
      <FilaTotal titulo="UTILIDAD ANTES DE ISLR" valores={r.map((x) => x.utilidadAntesIslr)} m={m} />
      {sec((x) => x.islr)}
      <FilaTotal titulo="UTILIDAD NETA" valores={r.map((x) => x.utilidadNeta)} m={m} />
    </Cuerpo>
  );
}

function Flujo2({ f, m, cols }: { f: FlujoEfectivo[]; m: Moneda; cols: string[] }) {
  const n = f.length;
  const sec = (g: (x: FlujoEfectivo) => Grupo) => (f.every((x) => g(x).lineas.length === 0) ? null : <FilaGrupo g={f.map(g)} m={m} n={n} />);
  return (
    <Cuerpo cols={cols} m={m}>
      <FilaTotal titulo="Utilidad neta del periodo" valores={f.map((x) => x.utilidadNeta)} m={m} fuerte={false} />
      <FilaTotal titulo="(+) Depreciación y otras partidas que no mueven efectivo" valores={f.map((x) => x.depreciacion)} m={m} fuerte={false} />
      {sec((x) => x.capitalTrabajo)}
      <FilaTotal titulo="EFECTIVO DE LAS OPERACIONES" valores={f.map((x) => x.efectivoOperacion)} m={m} />
      {sec((x) => x.inversion)}
      {sec((x) => x.financiamiento)}
      <FilaTotal titulo="VARIACIÓN NETA DEL EFECTIVO" valores={f.map((x) => x.variacion)} m={m} />
      <FilaTotal titulo="Efectivo al inicio (caja, bancos y activos digitales)" valores={f.map((x) => x.efectivoInicial)} m={m} fuerte={false} />
      <FilaTotal titulo="EFECTIVO AL FINAL" valores={f.map((x) => x.efectivoFinal)} m={m} />
      <tr><Celda className="text-xs text-texto-2">Diferencia contra el balance (debe ser cero)</Celda>{f.map((x, i) => <Celda key={i} derecha mono className={x.cuadra ? 'text-texto-2' : 'text-peligro'}>{fmt(x.diferencia, m)}</Celda>)}</tr>
    </Cuerpo>
  );
}

function Patrimonio({ c, m }: { c: CambiosPatrimonio; m: Moneda }) {
  const cols = c.columnas.filter((x) => c.filas.some((f) => !f.valores[x.clave].ves.isZero() || !f.valores[x.clave].usd.isZero()));
  return (
    <Tabla columnas={['Concepto', ...cols.map((x) => ({ t: x.titulo, derecha: true })), { t: 'Total patrimonio', derecha: true }]}>
      {c.filas.map((f, i) => (
        <tr key={f.titulo} className={i === c.filas.length - 1 ? 'border-t border-borde font-semibold' : ''}>
          <Celda>{f.titulo}</Celda>
          {cols.map((x) => <Celda key={x.clave} derecha mono>{fmt(f.valores[x.clave], m)}</Celda>)}
          <Celda derecha mono>{fmt(f.total, m)}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}

export default async function EstadosPage({ searchParams }: { searchParams: Promise<{ periodo?: string; tab?: string; moneda?: string }> }) {
  await exigirRol(...ROLES_VEN_ESTADOS);
  const q = await searchParams;
  const mm = /^(\d{4})-(\d{2})$/.exec(q.periodo ?? '');
  const periodo = mm && Number(mm[2]) >= 1 && Number(mm[2]) <= 12 ? q.periodo! : mesPasado();
  const [anio, mes] = periodo.split('-').map(Number);
  const tab = TABS.some((t) => t.id === q.tab) ? q.tab! : 'situacion';
  const m: Moneda = q.moneda === 'usd' ? 'usd' : 'ves';
  const db = await getDb();
  const e = await estadosDelMes(db, anio, mes);
  const flujo = tab === 'flujo' ? await flujoEfectivoDelMes(db, anio, mes) : null;
  const ant = rangoDeMes(anio, mes).anterior;
  const enlace = (extra: Record<string, string>) => `/contabilidad/estados?${new URLSearchParams({ periodo, tab, moneda: m, ...extra }).toString()}`;
  const alertas = !e.situacion.actual.cuadra || (flujo !== null && !flujo.periodo.cuadra);

  return (
    <>
      <Encabezado titulo="Estados financieros"
        descripcion="Se generan desde el mayor, por mes y con comparativos, en bolívares (legal) y en dólares (gestión: la suma de los valores en USD de cada asiento, sin reexpresión). El resultado del ejercicio que todavía no se cerró contra el patrimonio se muestra como partida del patrimonio." />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="tab" value={tab} />
          <label className="block"><span className="mb-1 block text-texto-2">Mes</span><input type="month" name="periodo" defaultValue={periodo} className="campo" /></label>
          <label className="block"><span className="mb-1 block text-texto-2">Moneda</span>
            <select name="moneda" defaultValue={m} className="campo"><option value="ves">Bolívares (VES, legal)</option><option value="usd">Dólares (USD, gestión)</option></select></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver</button>
        </form>
        <nav className="mt-4 flex flex-wrap gap-2 text-sm" aria-label="Estado">
          {TABS.map((t) => (
            <Link key={t.id} href={enlace({ tab: t.id })} className={`rounded-full border px-3 py-1 ${tab === t.id ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{t.texto}</Link>
          ))}
        </nav>
      </Panel>
      {alertas && <div className="mb-5"><Aviso tono="peligro">Un estado del mes no cuadra: avise a Contabilidad y al administrador antes de usar estos estados.</Aviso></div>}

      {tab === 'situacion' && (
        <Panel titulo={`Estado de situación financiera al cierre de ${etiquetaMes(anio, mes)}`}>
          <Situacion3 s={[e.situacion.actual, e.situacion.mesAnterior, e.situacion.cierreAnioAnterior]} m={m}
            cols={[etiquetaMes(anio, mes), `Cierre de ${etiquetaMes(ant.anio, ant.mes)}`, `Cierre de ${anio - 1}`]} />
        </Panel>
      )}
      {tab === 'resultados' && (
        <Panel titulo={`Estado de resultados de ${etiquetaMes(anio, mes)}`}>
          <Resultados3 r={[e.resultados.periodo, e.resultados.mesAnterior, e.resultados.acumuladoAnio]} m={m}
            cols={[etiquetaMes(anio, mes), etiquetaMes(ant.anio, ant.mes), `Acumulado de ${anio} al cierre de ${NOMBRE_MES[mes - 1]}`]} />
        </Panel>
      )}
      {flujo && (
        <Panel titulo={`Estado de flujo de efectivo de ${etiquetaMes(anio, mes)} (método indirecto)`}>
          <Flujo2 f={[flujo.periodo, flujo.acumuladoAnio]} m={m} cols={[etiquetaMes(anio, mes), `Acumulado de ${anio} al cierre de ${NOMBRE_MES[mes - 1]}`]} />
          <p className="mt-3 text-xs text-texto-2">
            Parte de la utilidad neta, suma lo que no mueve efectivo y los cambios del capital de trabajo, y agrega inversión y financiamiento. Los saldos de apertura del arranque son el efectivo inicial, no un flujo del mes.
          </p>
        </Panel>
      )}
      {tab === 'patrimonio' && (
        <Panel titulo={`Estado de cambios en el patrimonio de ${etiquetaMes(anio, mes)}`}>
          <Patrimonio c={e.patrimonio} m={m} />
        </Panel>
      )}
    </>
  );
}
