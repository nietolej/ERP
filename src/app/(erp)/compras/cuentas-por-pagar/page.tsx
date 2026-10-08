import Link from 'next/link';
import { Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { cuentasPorPagar } from '@/lib/compras/facturas';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';

export default async function CuentasPorPagarPage() {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const filas = await cuentasPorPagar(await getDb(), u);
  const totalUsd = filas.reduce((s, f) => s + Number(f.saldo_usd), 0);
  const vencidasUsd = filas.filter((f) => f.dias_vencida > 0).reduce((s, f) => s + Number(f.saldo_usd), 0);

  return (
    <>
      <Encabezado titulo="Cuentas por pagar"
        descripcion="Facturas de proveedor contabilizadas con saldo. Una factura retenida por diferencia de precio no aparece aquí hasta que Gerencia la apruebe." />
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <Panel titulo="Saldo por pagar (US$)"><p className="font-mono text-2xl">{monto(totalUsd)}</p></Panel>
        <Panel titulo="De ese saldo, vencido (US$)"><p className="font-mono text-2xl">{monto(vencidasUsd)}</p></Panel>
      </div>
      <Panel>
        <Tabla columnas={['Proveedor', 'Factura', 'Fecha', 'Vence', { t: 'Monto', derecha: true }, { t: 'Saldo', derecha: true }, { t: 'Saldo US$', derecha: true }, 'Situación']}
          vacio="No hay cuentas por pagar abiertas.">
          {filas.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda>{f.proveedor}</Celda>
              <Celda mono><Link href={f.factura_id ? `/compras/facturas/${f.factura_id}` : `/compras/gastos/${f.gasto_id}`} className="text-acento hover:underline">{f.numero_factura}</Link></Celda>
              <Celda className="text-texto-2">{f.fecha}</Celda>
              <Celda className="text-texto-2">{f.vencimiento}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.monto_original)}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.saldo)}</Celda>
              <Celda derecha mono>{monto(f.saldo_usd)}</Celda>
              <Celda>{f.dias_vencida > 0 ? <Etiqueta tono="peligro">{f.dias_vencida} días vencida</Etiqueta> : <Etiqueta tono="exito">al día</Etiqueta>}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
