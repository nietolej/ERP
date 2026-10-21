import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { buscarCuentasBancarias, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { ROLES_COBRAN, NOMBRE_TRAMO, partidasAbiertas, type TramoCxC } from '@/lib/ventas/cobros';
import { registrarCobroAccion } from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NuevoCobroPage({ searchParams }: { searchParams: Promise<{ cliente?: string; q?: string }> }) {
  await exigirRol(...ROLES_COBRAN);
  const { cliente = '', q = '' } = await searchParams;
  const db = await getDb();

  const elegido = UUID.test(cliente)
    ? (await db.query<{ id: string; codigo: string; razon: string }>(
      `select c.tercero_id as id, c.codigo, t.razon_social as razon from cliente c join tercero t on t.id = c.tercero_id where c.tercero_id = $1 and c.estado <> 'pendiente'`, [cliente])).rows[0]
    : undefined;
  const coincidencias = !elegido && q.trim()
    ? (await db.query<{ id: string; codigo: string; razon: string; deuda: string }>(
      `select c.tercero_id as id, c.codigo, t.razon_social as razon, coalesce((select sum(saldo_usd) from partida_cxc p where p.cliente_id = c.tercero_id and p.estado = 'abierta'), 0)::text as deuda
         from cliente c join tercero t on t.id = c.tercero_id
        where c.estado <> 'pendiente' and (c.codigo ilike '%' || $1 || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($1) || '%')
        order by t.razon_social limit 10`, [q.trim()])).rows
    : [];

  const [partidas, cuentas, instrumentos] = elegido
    ? await Promise.all([partidasAbiertas(db, elegido.id), buscarCuentasBancarias(db, { soloActivas: true }), listarInstrumentos(db)])
    : [[], [], []];

  return (
    <>
      <Encabezado titulo="Registrar cobro" descripcion="Indique el cliente, el pago y a qué facturas se aplica. Lo que no se aplique queda como anticipo del cliente.">
        <Link href="/cobranzas/cobros" className="text-sm text-texto-2 hover:text-texto">← Cobros</Link>
      </Encabezado>

      {!elegido && (
        <Panel titulo="¿De quién es el cobro?">
          <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
            <label className="block"><span className="mb-1 block text-texto-2">Cliente</span><input name="q" defaultValue={q} placeholder="Código o nombre" autoFocus className="campo w-72" /></label>
            <button type="submit" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Buscar</button>
          </form>
          {q.trim() && coincidencias.length === 0 && <p className="mt-4 text-sm text-texto-2">Ningún cliente aprobado coincide con la búsqueda.</p>}
          {coincidencias.length > 0 && (
            <ul className="mt-4 divide-y divide-borde text-sm">
              {coincidencias.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2">
                  <span>{c.codigo} · {c.razon}</span>
                  <span className="flex items-center gap-4">
                    <span className="text-texto-2">Debe US$ {monto(c.deuda)}</span>
                    <Link href={`/cobranzas/cobros/nuevo?cliente=${c.id}`} className="text-acento hover:underline">Elegir</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {elegido && (
        <Formulario accion={registrarCobroAccion} className="space-y-5">
          <input type="hidden" name="cliente_id" value={elegido.id} />
          <Panel titulo={`${elegido.codigo} · ${elegido.razon}`}>
            {cuentas.length === 0 ? (
              <Aviso tono="advertencia">No hay cuentas bancarias activas. Tesorería debe registrarlas en Tesorería → Cuentas bancarias y caja.</Aviso>
            ) : (
              <div className="grid gap-3 md:grid-cols-3 md:items-end">
                <Campo etiqueta="Fecha del cobro" ayuda="Hoy o anterior. La tasa BCV de esa fecha convierte el cobro.">
                  <input type="date" name="fecha" required defaultValue={hoyCaracas()} max={hoyCaracas()} className="campo" />
                </Campo>
                <Campo etiqueta="Instrumento de pago">
                  <select name="instrumento_id" required defaultValue="" className="campo">
                    <option value="" disabled>Seleccione…</option>
                    {instrumentos.map((i) => <option key={i.id} value={i.id}>{i.nombre}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Cuenta donde entró" ayuda="Su moneda es la del cobro.">
                  <select name="cuenta_bancaria_id" required defaultValue="" className="campo">
                    <option value="" disabled>Seleccione…</option>
                    {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.nombre} ({c.moneda})</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Monto cobrado" ayuda="En la moneda de la cuenta.">
                  <input name="monto" required inputMode="decimal" className="campo text-right tabular-nums" />
                </Campo>
                <Campo etiqueta="Referencia" ayuda="N° de transferencia, cheque, etc."><input name="referencia" maxLength={60} className="campo font-mono" /></Campo>
                <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={200} className="campo" /></Campo>
              </div>
            )}
          </Panel>

          <Panel titulo="Aplicar a facturas">
            <p className="mb-3 text-sm text-texto-2">
              Escriba en cada factura cuánto del cobro se aplica, en la moneda del cobro. Un cobro en divisas cancela <em>monto × tasa BCV</em> bolívares; marque «Liquida»
              si con ese monto queda pagada (se permite un centavo de la divisa de diferencia por la conversión). Deje en blanco lo que quede como anticipo.
            </p>
            <Tabla columnas={['Factura', 'Emitida', 'Vence', { t: 'Saldo Bs', derecha: true }, { t: 'Saldo USD', derecha: true }, 'Tramo', { t: 'Aplicar', derecha: true }, 'Liquida']}
              vacio="Este cliente no tiene facturas con saldo: todo el cobro quedará como anticipo.">
              {partidas.map((p) => (
                <tr key={p.partida_id}>
                  <Celda mono>{p.factura}</Celda>
                  <Celda>{fecha(p.fecha)}</Celda>
                  <Celda>{fecha(p.vencimiento)}</Celda>
                  <Celda derecha>{monto(p.saldo)}</Celda>
                  <Celda derecha>{monto(p.saldo_usd)}</Celda>
                  <Celda><Etiqueta tono={p.tramo === 'por_vencer' ? 'exito' : 'advertencia'}>{NOMBRE_TRAMO[p.tramo as TramoCxC]}</Etiqueta></Celda>
                  <Celda derecha><input name={`ap_${p.partida_id}`} inputMode="decimal" aria-label={`Aplicar a la factura ${p.factura}`} className="campo w-32 text-right tabular-nums" /></Celda>
                  <Celda><input type="checkbox" name={`liq_${p.partida_id}`} aria-label={`El cobro liquida la factura ${p.factura}`} /></Celda>
                </tr>
              ))}
            </Tabla>
          </Panel>
          {cuentas.length > 0 && <div className="text-right"><BotonEnviar>Registrar cobro</BotonEnviar></div>}
        </Formulario>
      )}
    </>
  );
}
