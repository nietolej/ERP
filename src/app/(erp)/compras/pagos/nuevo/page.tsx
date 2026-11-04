import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_PAGAN, partidasPorPagar } from '@/lib/compras/pagos';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { buscarCuentasBancarias, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { solicitarPagoAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SolicitarPagoPage({ searchParams }: { searchParams: Promise<{ proveedor?: string }> }) {
  await exigirRol(...ROLES_PAGAN);
  const { proveedor = '' } = await searchParams;
  const db = await getDb();
  const { rows: proveedores } = await db.query<{ id: string; nombre: string }>(
    `select p.tercero_id as id, p.codigo || ' · ' || t.razon_social as nombre
       from proveedor p join tercero t on t.id = p.tercero_id
      where p.estado = 'activo' and exists (select 1 from partida_cxp c where c.proveedor_id = p.tercero_id and c.estado = 'abierta')
         or p.tercero_id = $1::uuid
      order by p.codigo`, [UUID.test(proveedor) ? proveedor : null]);
  const elegido = proveedores.find((p) => p.id === proveedor);
  const [partidas, cuentas, instrumentos] = elegido
    ? await Promise.all([partidasPorPagar(db, elegido.id), buscarCuentasBancarias(db, { soloActivas: true }), listarInstrumentos(db)])
    : [[], [], []];
  const hoy = hoyCaracas();

  return (
    <>
      <Encabezado titulo="Solicitar pago a proveedor"
        descripcion="Escoja el proveedor y las facturas que se pagan. El pago no mueve nada hasta que Gerencia lo apruebe.">
        <Link href="/compras/pagos" className="text-sm text-texto-2 hover:text-texto">← Pagos</Link>
      </Encabezado>
      <Panel titulo="Proveedor" className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Proveedor con facturas por pagar</span>
            <select name="proveedor" defaultValue={proveedor} className="campo min-w-[18rem]">
              <option value="">Seleccione…</option>
              {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver facturas</button>
        </form>
      </Panel>
      {elegido && (
        partidas.length === 0 ? (
          <Aviso tono="advertencia">Este proveedor no tiene facturas por pagar. Si el pago es un anticipo, solicítelo sin marcar facturas.</Aviso>
        ) : null
      )}
      {elegido && (
        <Formulario accion={solicitarPagoAccion} className="space-y-5">
          <input type="hidden" name="proveedor_id" value={elegido.id} />
          <Panel titulo={`Facturas por pagar de ${elegido.nombre}`}>
            <Tabla columnas={['Pagar', 'Factura', 'Vence', { t: 'Saldo', derecha: true }, { t: 'Monto a aplicar (moneda del pago)', derecha: true }, 'Liquida']}
              vacio="Sin facturas por pagar: el monto completo quedará como anticipo.">
              {partidas.map((p) => (
                <tr key={p.partida_id}>
                  <Celda><input type="checkbox" name="partida" value={p.partida_id} className="h-4 w-4" aria-label={`Pagar ${p.factura}`} /></Celda>
                  <Celda mono>{p.factura}</Celda>
                  <Celda className={p.dias_vencida > 0 ? 'text-peligro' : 'text-texto-2'}>{fecha(p.vencimiento)}{p.dias_vencida > 0 ? ` · vencida ${p.dias_vencida} d` : ''}</Celda>
                  <Celda derecha mono>{p.moneda} {monto(p.saldo)}</Celda>
                  <Celda derecha><input name={`monto_${p.partida_id}`} defaultValue={p.saldo} inputMode="decimal" className="campo w-36 text-right" aria-label={`Monto de ${p.factura}`} /></Celda>
                  <Celda><input type="checkbox" name={`liquida_${p.partida_id}`} value="1" className="h-4 w-4" aria-label={`Liquida ${p.factura}`} /></Celda>
                </tr>
              ))}
            </Tabla>
            <p className="mt-3 text-xs text-texto-2">
              «Liquida» cierra la factura aunque el pago sea en otra moneda (con un centavo de tolerancia por la conversión a la tasa BCV de la fecha).
              Lo que no se aplique a ninguna factura queda como anticipo al proveedor.
            </p>
          </Panel>
          <Panel titulo="Datos del pago">
            <div className="grid gap-4 sm:grid-cols-3">
              <Campo etiqueta="Fecha"><input type="date" name="fecha" required max={hoy} defaultValue={hoy} className="campo" /></Campo>
              <Campo etiqueta="Cuenta de donde sale">
                <select name="cuenta_bancaria_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.nombre} ({c.moneda})</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Instrumento">
                <select name="instrumento_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {instrumentos.map((i) => <option key={i.id} value={i.id}>{i.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Monto del pago (moneda de la cuenta)"><input name="monto" required inputMode="decimal" className="campo text-right" /></Campo>
              <Campo etiqueta="Referencia" ayuda="No se repite en la misma cuenta."><input name="referencia" maxLength={60} autoComplete="off" className="campo font-mono uppercase" /></Campo>
              <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={300} className="campo" /></Campo>
            </div>
            <div className="mt-5 flex justify-end"><BotonEnviar>Solicitar pago</BotonEnviar></div>
          </Panel>
        </Formulario>
      )}
    </>
  );
}
