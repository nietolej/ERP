import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { listarCasos, NOMBRE_ESTADO_CASO, NOMBRE_TIPO_CASO, TIPOS_CASO } from '@/lib/crm/casos';
import { ROLES_CASOS, ROLES_VEN_CASOS } from '@/lib/crm/comun';
import { getDb } from '@/lib/db';
import { buscarClientes } from '@/lib/maestros/clientes';
import { abrirCasoAccion } from '../acciones';

const FILTROS = [['pendientes', 'Pendientes'], ['resuelto', 'Resueltos'], ['cerrado', 'Cerrados'], ['', 'Todos']] as const;

export default async function CasosPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CASOS);
  const sp = await searchParams;
  const estado = FILTROS.some(([v]) => v === sp.estado) ? sp.estado! : 'pendientes';
  const db = await getDb();
  const abre = tieneRol(u, [...ROLES_CASOS]);
  const [filas, clientes] = await Promise.all([
    listarCasos(db, u, { estado }),
    abre ? buscarClientes(db, u, { estado: 'activo' }, 2000) : Promise.resolve([]),
  ]);

  return (
    <>
      <Encabezado titulo="Casos de postventa"
        descripcion="Reclamos, garantías, devoluciones y consultas de los clientes. Una devolución no mueve inventario: se resuelve con su nota de crédito por devolución." />
      {abre && (
        <Panel titulo="Abrir un caso" className="mb-5">
          <Formulario accion={abrirCasoAccion} className="grid gap-4 sm:grid-cols-3">
            <Campo etiqueta="Cliente">
              <select name="cliente_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.razon_social}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Tipo">
              <select name="tipo" required defaultValue="reclamo" className="campo">
                {TIPOS_CASO.map((t) => <option key={t} value={t}>{NOMBRE_TIPO_CASO[t]}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Número de factura" ayuda="Obligatorio para una devolución."><input name="factura" className="campo font-mono" autoComplete="off" /></Campo>
            <div className="sm:col-span-3"><Campo etiqueta="Descripción"><textarea name="descripcion" required rows={2} className="campo" /></Campo></div>
            <div className="sm:col-span-3 flex justify-end"><BotonEnviar>Abrir caso</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map(([v, t]) => (
            <Link key={v || 'todos'} href={`/crm/casos?estado=${v}`}
              className={`rounded-full border px-3 py-1 ${estado === v ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{t}</Link>
          ))}
        </nav>
        <Tabla columnas={['Caso', 'Cliente', 'Tipo', 'Factura', 'Responsable', 'Abierto', { t: 'Días', derecha: true }, 'Estado']} vacio="No hay casos con ese filtro.">
          {filas.map((k) => (
            <tr key={k.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/crm/casos/${k.id}`} className="text-acento hover:underline">{k.numero}</Link></Celda>
              <Celda>{k.cliente}</Celda>
              <Celda>{NOMBRE_TIPO_CASO[k.tipo]}</Celda>
              <Celda mono className="text-texto-2">{k.factura ?? '—'}</Celda>
              <Celda className="text-texto-2">{k.responsable ?? '—'}</Celda>
              <Celda className="text-texto-2">{k.abierto}</Celda>
              <Celda derecha mono>{k.dias}</Celda>
              <Celda><Etiqueta tono={k.estado === 'cerrado' ? 'exito' : k.estado === 'resuelto' ? 'info' : 'advertencia'}>{NOMBRE_ESTADO_CASO[k.estado]}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
