import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { ROLES_REGISTRAN_GASTO, listarCategorias, opcionesGasto } from '@/lib/gastos/gastos';
import { crearGastoAccion } from '../acciones';

export default async function NuevoGastoPage() {
  await exigirRol(...ROLES_REGISTRAN_GASTO);
  const db = await getDb();
  const [categorias, { proveedores, alicuotas, monedas }] = await Promise.all([listarCategorias(db, true), opcionesGasto(db)]);
  const hoy = hoyCaracas();

  return (
    <>
      <Encabezado titulo="Registrar factura de gasto"
        descripcion="Con el soporte de la factura. No mueve nada hasta que Gerencia la apruebe; al aprobarse se practican las retenciones, nace la cuenta por pagar y se contabiliza.">
        <Link href="/gastos" className="text-sm text-texto-2 hover:text-texto">← Gastos</Link>
      </Encabezado>
      {categorias.length === 0 && <Aviso tono="advertencia">No hay categorías de gasto activas. Contabilidad debe crearlas en Gastos → Categorías.</Aviso>}
      <Formulario accion={crearGastoAccion} className="space-y-5">
        <Panel titulo="Factura del proveedor">
          <div className="grid gap-4 sm:grid-cols-3">
            <Campo etiqueta="Proveedor">
              <select name="proveedor_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {proveedores.map((p) => <option key={p.id} value={p.id}>{p.texto}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Categoría del gasto">
              <select name="categoria_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.iva_deducible ? '' : ' (IVA no deducible)'}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Descripción"><input name="descripcion" required minLength={3} maxLength={200} className="campo" /></Campo>
            <Campo etiqueta="Número de factura"><input name="numero_factura" required maxLength={40} autoComplete="off" className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="Número de control"><input name="numero_control" required maxLength={40} autoComplete="off" className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="Fecha de la factura"><input type="date" name="fecha_factura" required max={hoy} defaultValue={hoy} className="campo" /></Campo>
            <Campo etiqueta="Vencimiento" ayuda="Si lo deja vacío: fecha + días de la condición de pago del proveedor.">
              <input type="date" name="fecha_vencimiento" className="campo" />
            </Campo>
            <Campo etiqueta="Moneda">
              <select name="moneda" required defaultValue="VES" className="campo">{monedas.map((m) => <option key={m} value={m}>{m}</option>)}</select>
            </Campo>
            <Campo etiqueta="Monto sin IVA"><input name="base" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
            <Campo etiqueta="Alícuota de IVA">
              <select name="alicuota_iva_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {alicuotas.map((a) => <option key={a.id} value={a.id}>{a.texto}</option>)}
              </select>
            </Campo>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="retencion_iva_total" value="1" className="h-4 w-4" />
              Retener el 100 % del IVA (IVA no discriminado, factura que no cumple requisitos o proveedor sin RIF)
            </label>
            <Campo etiqueta="Soporte (PDF, PNG, JPG o WebP, hasta 5 MB)">
              <input type="file" name="archivo" accept=".pdf,.png,.jpg,.jpeg,.webp" required className="campo" />
            </Campo>
          </div>
          <div className="mt-5 flex justify-end"><BotonEnviar>Registrar gasto</BotonEnviar></div>
        </Panel>
      </Formulario>
    </>
  );
}
