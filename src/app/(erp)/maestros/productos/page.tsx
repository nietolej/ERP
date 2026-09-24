import Link from 'next/link';
import { ListaProductos } from '@/components/lista-productos';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { ROLES_VEN_PRODUCTOS, buscarProductos } from '@/lib/maestros/productos';
import { buscarProductosAccion } from './acciones';

const LIMITE = 100;

export default async function ProductosPage() {
  const u = await exigirRol(...ROLES_VEN_PRODUCTOS);
  const filas = await buscarProductos(await getDb(), { estado: 'activo' }, hoyCaracas(), LIMITE);
  const esAlmacen = tieneRol(u, ['almacen']);
  return (
    <>
      <Encabezado titulo="Productos" descripcion="Precios vigentes hoy en USD. El costo no es una lista de precio: sale del inventario.">
        <div className="flex gap-2">
          <Link href="/maestros/productos/catalogos" className="rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">
            Categorías, grupos y marcas
          </Link>
          {esAlmacen && (
            <Link href="/maestros/productos/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
              Nuevo producto
            </Link>
          )}
        </div>
      </Encabezado>
      <Panel>
        <ListaProductos iniciales={filas} buscar={buscarProductosAccion} limite={LIMITE} />
      </Panel>
    </>
  );
}
