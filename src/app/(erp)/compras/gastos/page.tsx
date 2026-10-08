import Link from 'next/link';
import { Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_CRITERIO, type CriterioReparto } from '@/lib/compras/costo-destino';
import { ROLES_REGISTRAN_FACTURA } from '@/lib/compras/facturas';
import { CONCEPTOS_GASTO, NOMBRE_CONCEPTO, buscarGastos, type ConceptoGasto } from '@/lib/compras/gastos-importacion';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';

export default async function GastosPage() {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const filas = await buscarGastos(await getDb(), u);
  return (
    <>
      <Encabezado titulo="Gastos de importación"
        descripcion="Flete, seguro, aranceles y agente de aduana: se reparten entre los productos de las recepciones por valor, peso, volumen o cantidad, y se suman al costo de lo que sigue en existencia.">
        {tieneRol(u, ROLES_REGISTRAN_FACTURA) && (
          <Link href="/compras/gastos/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Registrar gasto
          </Link>
        )}
      </Encabezado>
      <Panel>
        <Tabla columnas={['Registro', 'Concepto', 'Factura', 'Proveedor', 'Fecha', 'Se reparte por', { t: 'Recepciones', derecha: true }, { t: 'Monto sin IVA', derecha: true }, 'Estado']}
          vacio="Todavía no hay gastos de importación.">
          {filas.map((g) => (
            <tr key={g.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/compras/gastos/${g.id}`} className="text-acento hover:underline">{g.numero ?? 'Borrador'}</Link></Celda>
              <Celda>{(CONCEPTOS_GASTO as readonly string[]).includes(g.concepto) ? NOMBRE_CONCEPTO[g.concepto as ConceptoGasto] : g.concepto}</Celda>
              <Celda mono>{g.numero_factura}</Celda>
              <Celda>{g.proveedor}</Celda>
              <Celda className="text-texto-2">{g.fecha}</Celda>
              <Celda className="text-texto-2">{NOMBRE_CRITERIO[g.criterio_reparto as CriterioReparto]}</Celda>
              <Celda derecha mono>{g.recepciones}</Celda>
              <Celda derecha mono>{g.moneda} {monto(g.base)}</Celda>
              <Celda><Etiqueta tono={g.estado === 'contabilizado' ? 'exito' : 'info'}>{g.estado === 'contabilizado' ? 'registrado' : 'borrador'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
