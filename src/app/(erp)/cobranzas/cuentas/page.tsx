import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { NOMBRE_TRAMO, ROLES_COBRAN, ROLES_VEN_COBROS, TRAMOS_CXC, cuadreCxC, resumenCxC } from '@/lib/ventas/cobros';

export default async function CuentasPorCobrarPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COBROS);
  const { q = '' } = await searchParams;
  const db = await getDb();
  const [filas, cuadre] = await Promise.all([resumenCxC(db, u, q), cuadreCxC(db)]);
  const puedeCobrar = tieneRol(u, [...ROLES_COBRAN]);
  const total = (campo: (f: (typeof filas)[number]) => string) => filas.reduce((s, f) => s + Number(campo(f)), 0);

  return (
    <>
      <Encabezado titulo="Cuentas por cobrar"
        descripcion="Lo que deben los clientes, con su antigüedad por vencimiento. El saldo en USD es el valor de cada factura a su tasa de emisión." >
        <Link href="/cobranzas/cobros" className="text-sm text-acento hover:underline">Ver cobros →</Link>
      </Encabezado>

      <div className="mb-5">
        {cuadre.cuadra
          ? <Aviso tono="exito">El auxiliar cuadra con el mayor al centavo: cuentas por cobrar Bs. {monto(cuadre.mayor_ves)} y US$ {monto(cuadre.mayor_usd)}; anticipos de clientes Bs. {monto(cuadre.anticipos_mayor_ves)} y US$ {monto(cuadre.anticipos_mayor_usd)}.</Aviso>
          : (
            <Aviso tono="peligro">
              El auxiliar NO cuadra con el mayor. Cuentas por cobrar: auxiliar Bs. {monto(cuadre.auxiliar_ves)} / US$ {monto(cuadre.auxiliar_usd)} contra mayor Bs. {monto(cuadre.mayor_ves)} / US$ {monto(cuadre.mayor_usd)}.
              Anticipos: auxiliar Bs. {monto(cuadre.anticipos_auxiliar_ves)} / US$ {monto(cuadre.anticipos_auxiliar_usd)} contra mayor Bs. {monto(cuadre.anticipos_mayor_ves)} / US$ {monto(cuadre.anticipos_mayor_usd)}. Avise a Contabilidad.
            </Aviso>
          )}
      </div>

      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Cliente</span><input name="q" defaultValue={q} placeholder="Código o nombre" className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Buscar</button>
          {q && <Link href="/cobranzas/cuentas" className="py-2 text-texto-2 hover:text-texto">Restablecer</Link>}
        </form>
        <Tabla
          columnas={['Cliente', { t: 'Facturas', derecha: true }, { t: 'Saldo Bs', derecha: true }, { t: 'Saldo USD', derecha: true },
            ...TRAMOS_CXC.map((t) => ({ t: NOMBRE_TRAMO[t], derecha: true })), { t: 'Anticipos USD', derecha: true }, ...(puedeCobrar ? [''] : [])]}
          vacio={q ? 'Ningún cliente con saldo coincide con la búsqueda.' : 'No hay cuentas por cobrar abiertas.'}>
          {filas.map((f) => (
            <tr key={f.cliente_id} className="hover:bg-white/[0.03]">
              <Celda><Link href={`/maestros/clientes/${f.cliente_id}`} className="text-acento hover:underline">{f.codigo}</Link> <span className="text-texto-2">· {f.cliente}</span></Celda>
              <Celda derecha mono>{f.facturas}</Celda>
              <Celda derecha>{monto(f.saldo_ves)}</Celda>
              <Celda derecha className="font-semibold">{monto(f.saldo_usd)}</Celda>
              {TRAMOS_CXC.map((t) => (
                <Celda key={t} derecha className={t !== 'por_vencer' && Number(f.tramos[t]) > 0 ? 'text-amber-200' : 'text-texto-2'}>{Number(f.tramos[t]) > 0 ? monto(f.tramos[t]) : '—'}</Celda>
              ))}
              <Celda derecha className="text-texto-2">{Number(f.anticipos_usd) > 0 ? <Etiqueta tono="info">{monto(f.anticipos_usd)}</Etiqueta> : '—'}</Celda>
              {puedeCobrar && <Celda><Link href={`/cobranzas/cobros/nuevo?cliente=${f.cliente_id}`} className="text-xs text-acento hover:underline">Registrar cobro</Link></Celda>}
            </tr>
          ))}
          {filas.length > 0 && (
            <tr className="border-t-2 border-borde font-semibold">
              <Celda>Total</Celda>
              <Celda derecha mono>{filas.reduce((s, f) => s + f.facturas, 0)}</Celda>
              <Celda derecha>{monto(total((f) => f.saldo_ves))}</Celda>
              <Celda derecha>{monto(total((f) => f.saldo_usd))}</Celda>
              {TRAMOS_CXC.map((t) => <Celda key={t} derecha>{monto(total((f) => f.tramos[t]))}</Celda>)}
              <Celda derecha>{monto(total((f) => f.anticipos_usd))}</Celda>
              {puedeCobrar && <Celda>{''}</Celda>}
            </tr>
          )}
        </Tabla>
        <p className="mt-3 text-xs text-texto-2">Los tramos son días de vencimiento (días después de la fecha de vencimiento de la factura) y se expresan en USD.</p>
      </Panel>
    </>
  );
}
