import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { listarMotivos } from '@/lib/maestros/motivos';
import { CLASES_NC, CLASES_ND, NOMBRE_CLASE_NC, NOMBRE_CLASE_ND, ROLES_CREAN_NOTAS, buscarFacturasParaNota, lineasFacturables } from '@/lib/ventas/notas';
import { verTodosLosDocumentos } from '@/lib/ventas/pedidos';
import { crearNotaCreditoAccion, crearNotaDebitoAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NuevaNotaPage({ searchParams }: { searchParams: Promise<{ factura?: string; tipo?: string; q?: string }> }) {
  const u = await exigirRol(...ROLES_CREAN_NOTAS);
  const { factura = '', tipo = 'credito', q = '' } = await searchParams;
  const db = await getDb();

  const f = UUID.test(factura)
    ? (await db.query<{ id: string; numero: string; cliente: string; cliente_codigo: string; total: string; saldo: string | null; vendedor_usuario: string | null }>(
      `select d.id, d.serie || '-' || d.numero as numero, t.razon_social as cliente, c.codigo as cliente_codigo, d.total::text, p.saldo::text as saldo, v.usuario_id as vendedor_usuario
         from documento_venta d join cliente c on c.tercero_id = d.cliente_id join tercero t on t.id = d.cliente_id
         left join vendedor v on v.id = d.vendedor_id left join partida_cxc p on p.documento_id = d.id
        where d.id = $1 and d.tipo = 'factura' and d.estado = 'emitido'`, [factura])).rows[0]
    : undefined;
  const permitida = f && (verTodosLosDocumentos(u) || f.vendedor_usuario === u.id);
  const coincidencias = !permitida && q.trim() ? await buscarFacturasParaNota(db, u, q) : [];

  const [lineas, motivosDevolucion, motivosDescuento] = permitida
    ? await Promise.all([lineasFacturables(db, f.id), listarMotivos(db, { tipo: 'devolucion', soloActivos: true }), listarMotivos(db, { tipo: 'descuento', soloActivos: true })])
    : [[], [], []];
  const esCredito = tipo !== 'debito';

  return (
    <>
      <Encabezado titulo={esCredito ? 'Nueva nota de crédito' : 'Nueva nota de débito'} descripcion="Siempre sobre una factura emitida. Va en bolívares, con los precios y el IVA de la factura.">
        <Link href="/ventas/notas" className="text-sm text-texto-2 hover:text-texto">← Notas</Link>
      </Encabezado>

      {!permitida && (
        <Panel titulo="¿Sobre qué factura?">
          <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
            <input type="hidden" name="tipo" value={tipo} />
            <label className="block"><span className="mb-1 block text-texto-2">Factura o cliente</span><input name="q" defaultValue={q} placeholder="N° de factura, código o nombre del cliente" autoFocus className="campo w-80" /></label>
            <button type="submit" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Buscar</button>
          </form>
          {q.trim() && coincidencias.length === 0 && <p className="mt-4 text-sm text-texto-2">Ninguna factura emitida coincide con la búsqueda.</p>}
          {coincidencias.length > 0 && (
            <ul className="mt-4 divide-y divide-borde text-sm">
              {coincidencias.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="font-mono">{x.numero}</span> · {x.cliente_codigo} {x.cliente} · {x.fecha}</span>
                  <span className="flex items-center gap-4">
                    <span className="text-texto-2">Total Bs. {monto(x.total)} · saldo {x.saldo === null ? '—' : `Bs. ${monto(x.saldo)}`}</span>
                    <Link href={`/ventas/notas/nueva?factura=${x.id}&tipo=credito`} className="text-acento hover:underline">Crédito</Link>
                    <Link href={`/ventas/notas/nueva?factura=${x.id}&tipo=debito`} className="text-acento hover:underline">Débito</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {permitida && esCredito && (
        <Formulario accion={crearNotaCreditoAccion} className="space-y-5">
          <input type="hidden" name="factura_id" value={f.id} />
          <Panel titulo={`Factura ${f.numero} · ${f.cliente_codigo} ${f.cliente}`}>
            <p className="mb-4 text-sm text-texto-2">Total Bs. {monto(f.total)} · saldo por cobrar {f.saldo === null ? '—' : `Bs. ${monto(f.saldo)}`}. Una nota de crédito no supera ese saldo.</p>
            {f.saldo === null || Number(f.saldo) <= 0 ? (
              <Aviso tono="advertencia">Esta factura ya no tiene saldo por cobrar: una nota de crédito no puede reducirlo. El caso de una factura cobrada (devolver el dinero) está pendiente.</Aviso>
            ) : null}
            <div className="mt-4 grid gap-3 md:grid-cols-3 md:items-end">
              <Campo etiqueta="Clase">
                <select name="clase" required defaultValue="devolucion" className="campo">{CLASES_NC.map((c) => <option key={c} value={c}>{NOMBRE_CLASE_NC[c]}</option>)}</select>
              </Campo>
              <Campo etiqueta="Motivo" ayuda="Devolución: catálogo de devoluciones. Descuentos: catálogo de descuentos (el pronto pago usa el suyo).">
                <select name="motivo_id" defaultValue="" className="campo">
                  <option value="">— Automático (pronto pago) —</option>
                  <optgroup label="Devoluciones">{motivosDevolucion.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</optgroup>
                  <optgroup label="Descuentos">{motivosDescuento.filter((m) => !m.sistema).map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</optgroup>
                </select>
              </Campo>
              <Campo etiqueta="Porcentaje (descuentos)" ayuda="Sobre el precio neto de cada línea elegida."><input name="porcentaje" inputMode="decimal" className="campo text-right tabular-nums" /></Campo>
              <div className="md:col-span-3"><Campo etiqueta="Observaciones"><input name="observaciones" maxLength={250} className="campo" /></Campo></div>
            </div>
          </Panel>
          <Panel titulo="Líneas de la factura">
            <p className="mb-3 text-sm text-texto-2">
              <strong>Devolución:</strong> escriba cuánto se devuelve de cada línea (hasta lo disponible). <strong>Descuentos:</strong> marque las líneas a las que aplica (sin marcar, todas).
            </p>
            <Tabla columnas={['Código', 'Descripción', { t: 'Facturada', derecha: true }, { t: 'Devuelta', derecha: true }, { t: 'Disponible', derecha: true }, { t: 'Precio Bs.', derecha: true }, { t: 'IVA %', derecha: true }, { t: 'Devolver', derecha: true }, 'Descuento']}>
              {lineas.map((l) => (
                <tr key={l.id}>
                  <Celda mono>{l.codigo}</Celda>
                  <Celda>{l.descripcion}</Celda>
                  <Celda derecha mono>{Number(l.cantidad)}</Celda>
                  <Celda derecha mono>{Number(l.devuelta)}</Celda>
                  <Celda derecha mono>{Number(l.disponible)}</Celda>
                  <Celda derecha>{monto(l.precio_unitario)}</Celda>
                  <Celda derecha mono>{Number(l.alicuota_pct)}</Celda>
                  <Celda derecha><input name={`dev_${l.id}`} inputMode="decimal" aria-label={`Cantidad devuelta de ${l.codigo}`} className="campo w-24 text-right tabular-nums" /></Celda>
                  <Celda><input type="checkbox" name={`sel_${l.id}`} aria-label={`Aplicar el descuento a ${l.codigo}`} /></Celda>
                </tr>
              ))}
            </Tabla>
          </Panel>
          <div className="text-right"><BotonEnviar>Crear nota de crédito</BotonEnviar></div>
        </Formulario>
      )}

      {permitida && !esCredito && (
        <Formulario accion={crearNotaDebitoAccion} className="space-y-5">
          <input type="hidden" name="factura_id" value={f.id} />
          <Panel titulo={`Factura ${f.numero} · ${f.cliente_codigo} ${f.cliente}`}>
            <div className="grid gap-3 md:grid-cols-3 md:items-end">
              <Campo etiqueta="Motivo">
                <select name="motivo" required defaultValue="intereses" className="campo">{CLASES_ND.map((c) => <option key={c} value={c}>{NOMBRE_CLASE_ND[c]}</option>)}</select>
              </Campo>
              <Campo etiqueta="Vencimiento" ayuda="Vacío = según la condición de pago del cliente."><input type="date" name="vencimiento" className="campo" /></Campo>
              <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={250} className="campo" /></Campo>
            </div>
          </Panel>
          <Panel titulo="Conceptos">
            <p className="mb-3 text-sm text-texto-2">Cada concepto es un producto del maestro (por ejemplo, un servicio «Intereses por mora») con su precio en bolívares; el IVA sale del producto.</p>
            <Tabla columnas={['Código del producto', 'Descripción (opcional)', { t: 'Cantidad', derecha: true }, { t: 'Precio Bs.', derecha: true }]}>
              {[1, 2, 3].map((n) => (
                <tr key={n}>
                  <Celda><input name={`c${n}_codigo`} maxLength={30} aria-label={`Código del concepto ${n}`} className="campo w-40 font-mono uppercase" /></Celda>
                  <Celda><input name={`c${n}_descripcion`} maxLength={120} aria-label={`Descripción del concepto ${n}`} className="campo" /></Celda>
                  <Celda derecha><input name={`c${n}_cantidad`} defaultValue="1" inputMode="decimal" aria-label={`Cantidad del concepto ${n}`} className="campo w-24 text-right tabular-nums" /></Celda>
                  <Celda derecha><input name={`c${n}_precio`} inputMode="decimal" aria-label={`Precio del concepto ${n}`} className="campo w-32 text-right tabular-nums" /></Celda>
                </tr>
              ))}
            </Tabla>
          </Panel>
          <div className="text-right"><BotonEnviar>Crear nota de débito</BotonEnviar></div>
        </Formulario>
      )}
    </>
  );
}
