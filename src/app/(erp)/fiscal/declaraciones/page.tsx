import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Celda, Encabezado, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import {
  NOMBRE_DECLARACION, ROLES_DECLARAN, declaraPorQuincena, listarDeclaraciones, previsualizar, type CifrasIva, type CifrasRetenciones, type TipoDeclaracion,
} from '@/lib/fiscal/declaraciones';
import { ROLES_VEN_LIBROS } from '@/lib/fiscal/libros';
import { fecha, monto } from '@/lib/formato';
import { declararAccion } from './acciones';

const TIPOS: TipoDeclaracion[] = ['iva', 'retenciones_iva', 'retenciones_islr'];

/** Mes anterior al actual en Caracas, como «AAAA-MM» (el último periodo que ya terminó). */
function mesPasado(): string {
  const c = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  c.setDate(1);
  c.setMonth(c.getMonth() - 1);
  return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`;
}

export default async function DeclaracionesPage({ searchParams }: { searchParams: Promise<{ tipo?: string; periodo?: string; quincena?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_LIBROS);
  const q = await searchParams;
  const db = await getDb();
  const tipo = TIPOS.includes(q.tipo as TipoDeclaracion) ? (q.tipo as TipoDeclaracion) : 'iva';
  const m = /^(\d{4})-(\d{2})$/.exec(q.periodo ?? '');
  const periodo = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? q.periodo! : mesPasado();
  const [anio, mes] = periodo.split('-').map(Number);
  const [prev, declaradas, porQuincena] = await Promise.all([previsualizar(db, tipo, anio, mes, Number(q.quincena) || null), listarDeclaraciones(db), declaraPorQuincena(db)]);
  const puede = tieneRol(u, ROLES_DECLARAN);
  const iva = prev.cifras as CifrasIva;
  const ret = prev.cifras as CifrasRetenciones;

  return (
    <>
      <Encabezado titulo="Declaraciones fiscales"
        descripcion="Declarar un periodo guarda sus cifras y archivos y lo cierra fiscalmente: ya no se pueden anular ni registrar documentos fechados en él. Las correcciones van con notas en el periodo abierto; solo Gerencia reabre. Los formatos de archivo son borradores que el contador valida antes de subirlos al portal." />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Declaración</span>
            <select name="tipo" defaultValue={tipo} className="campo">{TIPOS.map((t) => <option key={t} value={t}>{NOMBRE_DECLARACION[t]}</option>)}</select></label>
          <label className="block"><span className="mb-1 block text-texto-2">Mes</span><input type="month" name="periodo" defaultValue={periodo} className="campo" /></label>
          {tipo === 'retenciones_iva' && porQuincena && (
            <label className="block"><span className="mb-1 block text-texto-2">Quincena</span>
              <select name="quincena" defaultValue={String(prev.periodo.quincena ?? 1)} className="campo"><option value="1">Primera (1 al 15)</option><option value="2">Segunda (16 al fin)</option></select></label>
          )}
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Calcular</button>
        </form>
        {tipo === 'retenciones_iva' && porQuincena && <p className="mt-3 text-xs text-texto-2">La empresa es contribuyente especial: las retenciones de IVA se declaran por quincena.</p>}
      </Panel>

      <Panel titulo={`${NOMBRE_DECLARACION[tipo]} · ${fecha(prev.periodo.desde)} al ${fecha(prev.periodo.hasta)}`} className="mb-5">
        {prev.impedimentos.map((i) => <div key={i} className="mb-3"><Aviso tono="advertencia">{i}</Aviso></div>)}
        {tipo === 'iva' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-4">
              <KpiCard titulo="Débito fiscal (ventas, Bs.)" valor={monto(iva.debito)} subtitulo={`Base ${monto(iva.baseVentas)}`} />
              <KpiCard titulo="Crédito fiscal (compras, Bs.)" valor={monto(iva.credito)} subtitulo={`Base ${monto(iva.baseCompras)}`} />
              <KpiCard titulo="Excedente del mes anterior (Bs.)" valor={monto(iva.excedenteAnterior)} />
              <KpiCard titulo={Number(iva.cuotaPagar) > 0 ? 'Cuota tributaria a pagar (Bs.)' : 'Excedente que se traslada (Bs.)'} valor={monto(Number(iva.cuotaPagar) > 0 ? iva.cuotaPagar : iva.excedenteSiguiente)}
                tono={Number(iva.cuotaPagar) > 0 ? 'peligro' : 'exito'} />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-4">
              <KpiCard titulo="Retenciones de clientes del mes (Bs.)" valor={monto(iva.retencionesSoportadas)} subtitulo="Comprobantes recibidos que se descuentan aquí" />
              <KpiCard titulo="Retenciones del mes anterior (Bs.)" valor={monto(iva.retencionesAnteriores)} subtitulo="Sin descontar todavía" />
              <KpiCard titulo="Retenciones descontadas (Bs.)" valor={monto(iva.retencionesDescontadas)} />
              <KpiCard titulo="Retenciones que se trasladan (Bs.)" valor={monto(iva.retencionesSiguiente)} />
            </div>
            <p className="mt-3 text-xs text-texto-2">
              Resultado = débito − crédito − excedente anterior. Si es positivo, se le descuentan las retenciones de IVA que practicaron los clientes en el mes
              y las que trae el mes anterior; lo que no alcanza a descontarse se traslada al mes siguiente.
            </p>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard titulo="Comprobantes" valor={String(ret.comprobantes)} />
            <KpiCard titulo="Base (Bs.)" valor={monto(ret.baseVes)} />
            <KpiCard titulo="Retenido (Bs.)" valor={monto(ret.retenidoVes)} subtitulo={Number(ret.ajustesPorNotas) !== 0 ? `Más ${monto(ret.ajustesPorNotas)} de ajustes por notas de crédito, sin numerar` : undefined} />
          </div>
        )}
        {puede && prev.impedimentos.length === 0 && (
          <Formulario accion={declararAccion} className="mt-5 flex flex-wrap items-center gap-4">
            <input type="hidden" name="tipo" value={tipo} />
            <input type="hidden" name="periodo" value={periodo} />
            <input type="hidden" name="quincena" value={prev.periodo.quincena ?? ''} />
            <BotonEnviar>Declarar y cerrar el periodo</BotonEnviar>
            <p className="text-xs text-texto-2">Queda registrado quién declara y cuándo. No se puede deshacer sin la reapertura de Gerencia.</p>
          </Formulario>
        )}
      </Panel>

      <Panel titulo="Declaraciones hechas">
        <Tabla columnas={['Declaración', 'Periodo', 'Declarada', 'Resultado', 'Estado']} vacio="Todavía no se ha declarado nada.">
          {declaradas.map((d) => (
            <tr key={d.id} className={d.reabierta ? 'opacity-60' : ''}>
              <Celda><Link href={`/fiscal/declaraciones/${d.id}`} className="text-acento hover:underline">{NOMBRE_DECLARACION[d.tipo]}</Link></Celda>
              <Celda>{fecha(d.desde)} al {fecha(d.hasta)}</Celda>
              <Celda className="text-texto-2">{d.declarada_por} · {d.declarada}</Celda>
              <Celda mono>
                {d.tipo === 'iva'
                  ? (Number(d.cifras.cuotaPagar) > 0 ? `A pagar Bs. ${monto(String(d.cifras.cuotaPagar))}` : `Excedente Bs. ${monto(String(d.cifras.excedenteSiguiente))}`)
                  : `${d.cifras.comprobantes} comprobantes · Bs. ${monto(String(d.cifras.retenidoVes))}`}
              </Celda>
              <Celda>{d.reabierta ? <Etiqueta tono="peligro">reabierta</Etiqueta> : <Etiqueta tono="exito">vigente</Etiqueta>}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
