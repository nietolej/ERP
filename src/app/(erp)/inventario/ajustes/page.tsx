import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_AJUSTAN, ROLES_VEN_AJUSTES, buscarAjustes } from '@/lib/inventario/ajustes';

const FILTROS = [
  { valor: '', texto: 'Todos' },
  { valor: 'borrador', texto: 'Borradores' },
  { valor: 'pendiente', texto: 'Pendientes de aprobación' },
  { valor: 'aprobado', texto: 'Aprobados' },
  { valor: 'rechazado', texto: 'Rechazados' },
] as const;

const TONO = { borrador: 'info', pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function AjustesPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_AJUSTES);
  const { estado = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const filas = await buscarAjustes(await getDb(), u, { estado: filtro });
  const pendientes = filas.filter((f) => f.estado === 'pendiente').length;

  return (
    <>
      <Encabezado titulo="Ajustes de inventario"
        descripcion="Conteos contra el sistema. Los crea Almacén y los aprueba Gerencia; nunca quien creó el ajuste ni quien hizo el conteo.">
        {tieneRol(u, ROLES_AJUSTAN) && (
          <Link href="/inventario/ajustes/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Nuevo ajuste
          </Link>
        )}
      </Encabezado>
      {pendientes > 0 && filtro === '' && tieneRol(u, ['gerencia']) && (
        <div className="mb-5">
          <Aviso tono="advertencia">{pendientes === 1 ? 'Hay 1 ajuste pendiente' : `Hay ${pendientes} ajustes pendientes`} de aprobación.</Aviso>
        </div>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/inventario/ajustes?estado=${f.valor}` : '/inventario/ajustes'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Ajuste', 'Fecha', 'Almacén', 'Creó', { t: 'Líneas', derecha: true }, 'Estado']} vacio="No hay ajustes con ese filtro.">
          {filas.map((a) => (
            <tr key={a.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/inventario/ajustes/${a.id}`} className="text-acento hover:underline">{a.numero ?? 'Borrador'}</Link></Celda>
              <Celda className="text-texto-2">{a.fecha}</Celda>
              <Celda className="text-texto-2">{a.almacen}</Celda>
              <Celda>{a.creado_por}</Celda>
              <Celda derecha mono>{a.lineas}</Celda>
              <Celda><Etiqueta tono={TONO[a.estado as keyof typeof TONO] ?? 'info'}>{a.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
