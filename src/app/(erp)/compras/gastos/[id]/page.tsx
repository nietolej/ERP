import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_CRITERIO } from '@/lib/compras/costo-destino';
import { ROLES_REGISTRAN_FACTURA } from '@/lib/compras/facturas';
import { CONCEPTOS_GASTO, NOMBRE_CONCEPTO, calcularReparto, detalleGasto, type ConceptoGasto } from '@/lib/compras/gastos-importacion';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto } from '@/lib/formato';
import { mensajeDeError } from '@/lib/acciones';
import { actualizarGastoAccion, eliminarGastoAccion, registrarGastoAccion } from '../../acciones';
import { CamposGasto, opcionesGasto } from '../datos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function GastoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleGasto(db, id);
  if (!d) notFound();

  const borrador = d.estado === 'borrador';
  const puedeEditar = borrador && tieneRol(u, ROLES_REGISTRAN_FACTURA);
  const hoy = hoyCaracas();
  const op = puedeEditar ? await opcionesGasto(db, hoy) : null;

  // Vista previa del reparto con los datos guardados; si falta una medida, lo dice en lugar de mostrar cifras.
  let previa: Awaited<ReturnType<typeof calcularReparto>> | null = null;
  let errorPrevia: string | null = null;
  if (borrador) {
    try { previa = await calcularReparto(db, id); } catch (e) { errorPrevia = mensajeDeError(e); }
  }
  const concepto = (CONCEPTOS_GASTO as readonly string[]).includes(d.concepto) ? NOMBRE_CONCEPTO[d.concepto as ConceptoGasto] : d.concepto;
  const filasReparto = previa
    ? previa.lineas.map((l) => ({ codigo: l.codigo, recepcion: l.recepcion, cantidad: l.cantidad, monto: l.monto, inv: l.montoInventario, cv: l.montoCostoVentas }))
    : d.reparto.map((l) => ({ codigo: l.codigo, recepcion: l.recepcion, cantidad: l.cantidad, monto: l.monto, inv: l.monto_inventario, cv: l.monto_costo_ventas }));

  return (
    <>
      <Encabezado titulo={`${concepto} · factura ${d.numero_factura}`} descripcion={d.proveedor}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={borrador ? 'info' : 'exito'}>{borrador ? 'Borrador' : `Registrado ${d.numero}`}</Etiqueta>
          <Link href="/compras/gastos" className="text-sm text-texto-2 hover:text-texto">← Gastos</Link>
        </div>
      </Encabezado>

      {!borrador && <div className="mb-5"><Aviso tono="exito">Registrado. Saldo por pagar: {d.moneda} {monto(d.saldo ?? '0')}. Repartido por {NOMBRE_CRITERIO[d.criterio_reparto].toLowerCase()}.</Aviso></div>}

      <Panel titulo="Datos del gasto">
        {puedeEditar && op ? (
          <Formulario accion={actualizarGastoAccion} className="space-y-5">
            <input type="hidden" name="id" value={id} />
            <CamposGasto op={op} hoy={hoy}
              v={{ proveedor_id: d.proveedor_id, concepto: d.concepto, descripcion: d.descripcion, numero_factura: d.numero_factura, numero_control: d.numero_control,
                   fecha_factura: d.fecha_factura, fecha_vencimiento: d.fecha_vencimiento, moneda: d.moneda, criterio_reparto: d.criterio_reparto, base: d.base,
                   alicuota_iva_id: d.alicuota_iva_id, recepcion_ids: d.recepciones.map((r) => r.id) }} />
            <div className="flex justify-end"><BotonEnviar>Guardar datos</BotonEnviar></div>
          </Formulario>
        ) : (
          <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
            <div><dt className="text-texto-2">Número de control</dt><dd className="font-mono">{d.numero_control}</dd></div>
            <div><dt className="text-texto-2">Fecha</dt><dd>{d.fecha_factura.split('-').reverse().join('-')}</dd></div>
            <div><dt className="text-texto-2">Vence</dt><dd>{d.fecha_vencimiento.split('-').reverse().join('-')}</dd></div>
            <div><dt className="text-texto-2">Moneda</dt><dd>{d.moneda}{d.tasa && d.moneda !== 'VES' ? ` · tasa ${d.tasa}` : ''}</dd></div>
            <div><dt className="text-texto-2">Monto sin IVA</dt><dd className="font-mono">{monto(d.base)}</dd></div>
            <div><dt className="text-texto-2">IVA ({Number(d.alicuota_pct)} %)</dt><dd className="font-mono">{monto(d.iva)}</dd></div>
            <div><dt className="text-texto-2">Total</dt><dd className="font-mono">{d.moneda} {monto(d.total)}{d.moneda !== 'USD' && ` (US$ ${monto(d.total_usd)})`}</dd></div>
            <div><dt className="text-texto-2">Registró</dt><dd>{d.creado_por}</dd></div>
            {d.descripcion && <div className="md:col-span-3"><dt className="text-texto-2">Descripción</dt><dd>{d.descripcion}</dd></div>}
          </dl>
        )}
      </Panel>

      <Panel titulo={`Recepciones a las que se aplica (${d.recepciones.length})`} className="mt-5">
        <Tabla columnas={['Recepción', 'Orden de compra', 'Fecha', { t: 'Valor US$', derecha: true }]} vacio="No hay recepciones.">
          {d.recepciones.map((r) => (
            <tr key={r.id}>
              <Celda mono>{r.numero}</Celda>
              <Celda mono className="text-texto-2">{r.orden}</Celda>
              <Celda className="text-texto-2">{r.fecha}</Celda>
              <Celda derecha mono>{monto(r.total_usd)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <Panel titulo={borrador ? `Vista previa del reparto por ${NOMBRE_CRITERIO[d.criterio_reparto].toLowerCase()}` : 'Reparto'} className="mt-5">
        {errorPrevia ? <Aviso tono="peligro">{errorPrevia}</Aviso> : (
          <>
            <Tabla columnas={['Producto', 'Recepción', { t: 'Cantidad', derecha: true }, { t: `Parte del gasto ${d.moneda}`, derecha: true },
              { t: 'Al inventario', derecha: true }, { t: 'Al costo de ventas', derecha: true }]} vacio="Sin líneas.">
              {filasReparto.map((l, i) => (
                <tr key={i}>
                  <Celda mono>{l.codigo}</Celda>
                  <Celda mono className="text-texto-2">{l.recepcion}</Celda>
                  <Celda derecha mono>{Number(l.cantidad)}</Celda>
                  <Celda derecha mono>{monto(l.monto)}</Celda>
                  <Celda derecha mono>{monto(l.inv)}</Celda>
                  <Celda derecha mono className={Number(l.cv) > 0 ? 'text-amber-300' : 'text-texto-2'}>{monto(l.cv)}</Celda>
                </tr>
              ))}
            </Tabla>
            <p className="mt-3 text-sm text-texto-2">
              “Al costo de ventas” es la parte que corresponde a unidades que ya se vendieron; el resto encarece el costo de lo que sigue en existencia.
            </p>
          </>
        )}
      </Panel>

      {puedeEditar && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {!errorPrevia && (
              <Formulario accion={registrarGastoAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-sm text-sm text-texto-2">Al registrarlo se reparte, se ajusta el costo, se abre la cuenta por pagar y se contabiliza. Ya no se edita.</p>
                <BotonEnviar>Registrar gasto</BotonEnviar>
              </Formulario>
            )}
            <Formulario accion={eliminarGastoAccion}><input type="hidden" name="id" value={id} /><BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
