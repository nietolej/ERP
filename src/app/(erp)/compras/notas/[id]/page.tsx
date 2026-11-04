import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TablaRetenciones } from '@/components/compras/tabla-retenciones';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_CLASE_NOTA, NOMBRE_ESTADO_NOTA, NOMBRE_TIPO_NOTA, detalleNota } from '@/lib/compras/notas-proveedor';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { retencionesDe } from '@/lib/compras/retenciones';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, monto } from '@/lib/formato';
import { aprobarNotaAccion, rechazarNotaAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro' } as const;

export default async function NotaProveedorPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleNota(db, id);
  if (!d) notFound();

  const pendiente = d.estado === 'pendiente';
  const puedeDecidir = pendiente && (await puedeDecidirObjeto(db, u.id, 'nota_proveedor', id));
  const retenciones = d.estado === 'aprobada' ? await retencionesDe(db, { notaId: id }) : [];
  const credito = d.tipo === 'nota_credito';

  return (
    <>
      <Encabezado titulo={`${NOMBRE_TIPO_NOTA[d.tipo]} N° ${d.numero}`} descripcion={`${d.proveedor} · ${NOMBRE_CLASE_NOTA[d.clase]}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_NOTA[d.estado] ?? d.estado}</Etiqueta>
          <Link href="/compras/notas" className="text-sm text-texto-2 hover:text-texto">← Notas</Link>
        </div>
      </Encabezado>

      {pendiente && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia. Mientras no se apruebe no sale mercancía, no cambia la cuenta por pagar y no hay asiento.</Aviso></div>}
      {pendiente && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">Lo debe decidir otra persona de Gerencia: quien registró la nota ({d.creador}) no la aprueba.</Aviso></div>
      )}
      {d.estado === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'aprobada' && <div className="mb-5"><Aviso tono="exito">Aprobada por {d.aprobado_por} el {d.aprobado}. Asiento {d.asiento ?? '—'}. Saldo por pagar de la factura: {d.moneda} {monto(d.saldo_factura ?? '0')}.</Aviso></div>}

      <Panel titulo="Datos de la nota">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Nota del proveedor</dt><dd className="font-mono">{d.numero_documento}</dd></div>
          <div><dt className="text-texto-2">Número de control</dt><dd className="font-mono">{d.numero_control}</dd></div>
          <div><dt className="text-texto-2">Fecha</dt><dd>{fecha(d.fecha)}</dd></div>
          <div><dt className="text-texto-2">Factura que corrige</dt><dd><Link href={`/compras/facturas/${d.factura_id}`} className="font-mono text-acento hover:underline">{d.factura}</Link></dd></div>
          <div><dt className="text-texto-2">Moneda y tasa (las de la factura)</dt><dd className="font-mono">{d.moneda}{d.moneda !== 'VES' ? ` · tasa ${d.tasa}` : ''}</dd></div>
          <div><dt className="text-texto-2">Registró</dt><dd>{d.creador} · {d.creado}</dd></div>
          <div className="md:col-span-3"><dt className="text-texto-2">Motivo</dt><dd>{d.motivo}</dd></div>
        </dl>
      </Panel>

      <Panel titulo="Líneas" className="mt-5">
        <Tabla columnas={['Producto', ...(d.clase === 'devolucion' ? [{ t: 'Unidades', derecha: true }] : []), { t: `Base (${d.moneda})`, derecha: true }, { t: 'IVA %', derecha: true }, { t: 'IVA', derecha: true }]}>
          {d.lineas.map((l) => (
            <tr key={l.linea}>
              <Celda><span className="font-mono">{l.codigo}</span><span className="block text-xs text-texto-2">{l.descripcion}</span></Celda>
              {d.clase === 'devolucion' && <Celda derecha mono>{Number(l.cantidad)}</Celda>}
              <Celda derecha mono>{monto(l.base)}</Celda>
              <Celda derecha mono>{Number(l.alicuota_pct)}</Celda>
              <Celda derecha mono>{monto(l.iva)}</Celda>
            </tr>
          ))}
        </Tabla>
        <dl className="mt-4 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
          <dt className="text-texto-2">Base imponible</dt><dd className="text-right font-mono">{monto(d.base_imponible)}</dd>
          <dt className="text-texto-2">Exento</dt><dd className="text-right font-mono">{monto(d.exento)}</dd>
          <dt className="text-texto-2">IVA</dt><dd className="text-right font-mono">{monto(d.iva)}</dd>
          <dt className="font-semibold">Total {d.moneda}</dt><dd className="text-right font-mono font-semibold">{monto(d.total)}</dd>
          {d.moneda !== 'USD' && <><dt className="text-texto-2">Equivale a US$</dt><dd className="text-right font-mono">{monto(d.total_usd)}</dd></>}
        </dl>
        <p className="mt-3 text-xs text-texto-2">
          {credito ? 'Al aprobar: reduce la cuenta por pagar de la factura (neta de retención)' : 'Al aprobar: abre su propia cuenta por pagar (neta de retención)'}
          {d.clase === 'devolucion' ? ', la mercancía sale del almacén donde se recibió al costo promedio y la diferencia con el crédito va al costo de ventas' : ' y ajusta el costo de lo que sigue en existencia (lo ya vendido va al costo de ventas)'}.
        </p>
      </Panel>

      <TablaRetenciones filas={retenciones} moneda={d.moneda} />

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarNotaAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="text-sm text-texto-2">Al aprobar se mueve el inventario, se ajusta la cuenta por pagar y las retenciones y se contabiliza, todo en el mismo acto.</p>
              <BotonEnviar>Aprobar nota</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarNotaAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar nota</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
