import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_REGISTRAN_NOTA_PROVEEDOR, lineasCorregibles } from '@/lib/compras/notas-proveedor';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto } from '@/lib/formato';
import { crearNotaAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NuevaNotaProveedorPage({ searchParams }: { searchParams: Promise<{ factura?: string }> }) {
  await exigirRol(...ROLES_REGISTRAN_NOTA_PROVEEDOR);
  const { factura = '' } = await searchParams;
  const db = await getDb();
  const { rows: facturas } = await db.query<{ id: string; texto: string; moneda: string }>(
    `select f.id, 'Factura ' || f.numero_factura || ' · ' || p.codigo || ' · ' || f.moneda || ' ' || f.total as texto, f.moneda
       from factura_compra f join proveedor p on p.tercero_id = f.proveedor_id where f.estado = 'contabilizada' order by f.numero desc limit 300`);
  const elegida = UUID.test(factura) ? facturas.find((f) => f.id === factura) : undefined;
  const lineas = elegida ? await lineasCorregibles(db, elegida.id) : [];
  const hoy = hoyCaracas();

  return (
    <>
      <Encabezado titulo="Registrar nota del proveedor"
        descripcion="Escoja la factura que corrige y las líneas. La nota no mueve nada hasta que Gerencia la apruebe.">
        <Link href="/compras/notas" className="text-sm text-texto-2 hover:text-texto">← Notas</Link>
      </Encabezado>
      <Panel titulo="Factura que se corrige" className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Factura contabilizada</span>
            <select name="factura" defaultValue={factura} className="campo min-w-[22rem]">
              <option value="">Seleccione…</option>
              {facturas.map((f) => <option key={f.id} value={f.id}>{f.texto}</option>)}
            </select></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver líneas</button>
        </form>
      </Panel>
      {elegida && (
        <Formulario accion={crearNotaAccion} className="space-y-5">
          <input type="hidden" name="factura_id" value={elegida.id} />
          <Panel titulo="Líneas de la factura">
            <Tabla columnas={['Corregir', 'Producto', { t: 'Facturado', derecha: true }, { t: 'Precio', derecha: true }, { t: 'Ya devuelto', derecha: true }, { t: 'Ya acreditado', derecha: true },
              { t: 'Unidades (devolución) o monto sin IVA (ajuste)', derecha: true }]}>
              {lineas.map((l) => (
                <tr key={l.id}>
                  <Celda><input type="checkbox" name="linea" value={l.id} className="h-4 w-4" aria-label={`Corregir ${l.codigo}`} /></Celda>
                  <Celda><span className="font-mono">{l.codigo}</span><span className="block text-xs text-texto-2">{l.descripcion}</span></Celda>
                  <Celda derecha mono>{Number(l.cantidad)}</Celda>
                  <Celda derecha mono>{elegida.moneda} {monto(l.precio_unitario)}</Celda>
                  <Celda derecha mono>{Number(l.devuelto)}</Celda>
                  <Celda derecha mono>{monto(l.acreditado)}</Celda>
                  <Celda derecha><input name={`valor_${l.id}`} inputMode="decimal" className="campo w-36 text-right" aria-label={`Valor de ${l.codigo}`} /></Celda>
                </tr>
              ))}
            </Tabla>
            <p className="mt-3 text-xs text-texto-2">
              La nota conserva la moneda y la tasa de la factura. Una nota de crédito no puede pasar del saldo por pagar de la factura; si la factura tuvo retención,
              se ajusta en proporción. La mercancía devuelta sale del almacén donde se recibió.
            </p>
          </Panel>
          <Panel titulo="Datos de la nota">
            <div className="grid gap-4 sm:grid-cols-3">
              <Campo etiqueta="Tipo de nota">
                <select name="tipo_clase" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  <option value="nota_credito:devolucion">Nota de crédito: devolución de mercancía</option>
                  <option value="nota_credito:ajuste_precio">Nota de crédito: ajuste de precio o descuento</option>
                  <option value="nota_debito:ajuste_precio">Nota de débito: ajuste de precio a mayor</option>
                </select>
              </Campo>
              <Campo etiqueta="Número de la nota del proveedor"><input name="numero_documento" required maxLength={40} autoComplete="off" className="campo font-mono uppercase" /></Campo>
              <Campo etiqueta="Número de control"><input name="numero_control" required maxLength={40} autoComplete="off" className="campo font-mono uppercase" /></Campo>
              <Campo etiqueta="Fecha de la nota"><input type="date" name="fecha" required max={hoy} defaultValue={hoy} className="campo" /></Campo>
              <div className="sm:col-span-2"><Campo etiqueta="Motivo"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo></div>
            </div>
            <div className="mt-5 flex justify-end"><BotonEnviar>Registrar nota</BotonEnviar></div>
          </Panel>
        </Formulario>
      )}
      {!elegida && facturas.length === 0 && <Aviso tono="advertencia">Todavía no hay facturas contabilizadas que corregir.</Aviso>}
    </>
  );
}
