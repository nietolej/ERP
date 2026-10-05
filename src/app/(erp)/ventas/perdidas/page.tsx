import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { buscarClientes } from '@/lib/maestros/clientes';
import { listarMotivos } from '@/lib/maestros/motivos';
import { ROLES_VENDEN, ROLES_VEN_VENTAS } from '@/lib/ventas/pedidos';
import { listarVentasPerdidas } from '@/lib/ventas/perdidas';
import { registrarVentaPerdidaAccion } from '../acciones';

export default async function VentasPerdidasPage() {
  const u = await exigirRol(...ROLES_VEN_VENTAS);
  const db = await getDb();
  const registra = tieneRol(u, ROLES_VENDEN);
  const [filas, clientes, almacenes, motivos] = await Promise.all([
    listarVentasPerdidas(db, u),
    registra ? buscarClientes(db, u, { estado: 'activo' }, 1000) : Promise.resolve([]),
    registra ? db.query<{ id: string; codigo: string; nombre: string }>(`select id, codigo, nombre from almacen where activo order by codigo`).then((r) => r.rows) : Promise.resolve([]),
    listarMotivos(db, { tipo: 'venta_perdida', soloActivos: true }),
  ]);

  return (
    <>
      <Encabezado titulo="Ventas perdidas"
        descripcion="Lo que un cliente quiso comprar y no se vendió, con su motivo. Lo que falta por existencia lo registra el sistema al aprobar un pedido; aquí se agregan las demás causas (precio, plazo, condición de pago)." />
      {registra && (
        <Panel titulo="Registrar una venta perdida">
          <Formulario accion={registrarVentaPerdidaAccion} className="grid gap-4 sm:grid-cols-3">
            <Campo etiqueta="Cliente">
              <select name="cliente_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.razon_social}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Código del producto"><input name="codigo" required autoComplete="off" className="campo font-mono uppercase" placeholder="PF-001" /></Campo>
            <Campo etiqueta="Cantidad"><input name="cantidad" required inputMode="decimal" className="campo" defaultValue="1" /></Campo>
            <Campo etiqueta="Almacén">
              <select name="almacen_id" required defaultValue={almacenes.length === 1 ? almacenes[0].id : ''} className="campo">
                <option value="" disabled>Seleccione…</option>
                {almacenes.map((a) => <option key={a.id} value={a.id}>{a.codigo} · {a.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Motivo">
              <select name="motivo_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Detalle" ayuda="Obligatorio si el motivo es Otro. Por ejemplo, el precio que ofrecía la competencia.">
              <input name="observacion" maxLength={200} className="campo" />
            </Campo>
            <div className="sm:col-span-3 flex justify-end"><BotonEnviar>Registrar</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}

      <Panel titulo="Últimos registros" className="mt-5">
        <Tabla columnas={['Fecha', 'Cliente', 'Producto', { t: 'Cantidad', derecha: true }, 'Almacén', 'Motivo', 'Origen']}
          vacio="Todavía no hay ventas perdidas registradas.">
          {filas.map((f) => (
            <tr key={f.id}>
              <Celda className="text-texto-2">{f.fecha}</Celda>
              <Celda>{f.cliente}</Celda>
              <Celda><span className="font-mono">{f.codigo}</span> <span className="text-texto-2">{f.producto}</span></Celda>
              <Celda derecha mono>{Number(f.cantidad)}</Celda>
              <Celda className="text-texto-2">{f.almacen}</Celda>
              <Celda>{f.motivo}{f.observacion ? <span className="text-texto-2"> · {f.observacion}</span> : null}</Celda>
              <Celda><Etiqueta tono={f.registro === 'manual' ? 'info' : 'advertencia'}>{f.registro === 'manual' ? 'Manual' : 'Sistema'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
