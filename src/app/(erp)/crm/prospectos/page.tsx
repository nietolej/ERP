import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_CRM, ROLES_VEN_CRM, soloLoSuyo } from '@/lib/crm/comun';
import { listarProspectos } from '@/lib/crm/prospectos';
import { getDb } from '@/lib/db';
import { registrarProspectoAccion } from '../acciones';

const FILTROS = [
  { valor: 'activo', texto: 'Activos' },
  { valor: 'convertido', texto: 'Convertidos en clientes' },
  { valor: 'descartado', texto: 'Descartados' },
  { valor: '', texto: 'Todos' },
] as const;
const TONO = { activo: 'info', convertido: 'exito', descartado: 'peligro' } as const;

export default async function ProspectosPage({ searchParams }: { searchParams: Promise<{ estado?: string; q?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const sp = await searchParams;
  const estado = FILTROS.some((f) => f.valor === sp.estado) ? sp.estado! : 'activo';
  const db = await getDb();
  const registra = tieneRol(u, [...ROLES_CRM]);
  const [filas, vendedores] = await Promise.all([
    listarProspectos(db, u, { estado, texto: sp.q }),
    registra && !soloLoSuyo(u)
      ? db.query<{ id: string; nombre: string }>(`select id, codigo || ' · ' || nombre as nombre from vendedor where estado = 'activo' order by codigo`).then((r) => r.rows)
      : Promise.resolve([]),
  ]);

  return (
    <>
      <Encabezado titulo="Prospectos"
        descripcion="Empresas o personas que aún no son clientes. No se les pide ni se les factura: al ganar su primera oportunidad se registran como clientes y Gerencia los aprueba." />

      {registra && (
        <Panel titulo="Registrar un prospecto" className="mb-5">
          <Formulario accion={registrarProspectoAccion} className="grid gap-4 sm:grid-cols-3">
            <Campo etiqueta="RIF" ayuda="Formato J-12345678-9."><input name="rif" required className="campo font-mono uppercase" autoComplete="off" /></Campo>
            <Campo etiqueta="Razón social o nombre"><input name="razon_social" required className="campo" /></Campo>
            <Campo etiqueta="Nombre comercial"><input name="nombre_comercial" className="campo" /></Campo>
            <Campo etiqueta="Teléfono"><input name="telefono" className="campo" autoComplete="off" /></Campo>
            <Campo etiqueta="Correo"><input name="email" type="email" className="campo" autoComplete="off" /></Campo>
            <Campo etiqueta="Cómo llegó" ayuda="Referido, visita, feria, redes…"><input name="origen" className="campo" /></Campo>
            <Campo etiqueta="Dirección"><input name="direccion_fiscal" className="campo" /></Campo>
            {vendedores.length > 0 && (
              <Campo etiqueta="Vendedor">
                <select name="vendedor_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
                </select>
              </Campo>
            )}
            <label className="flex items-center gap-2 self-end text-sm text-texto-2">
              <input type="checkbox" name="confirmar" /> Confirmo que no es un tercero ya registrado con nombre parecido
            </label>
            <div className="sm:col-span-3 flex justify-end"><BotonEnviar>Registrar prospecto</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}

      <Panel>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
            {FILTROS.map((f) => (
              <Link key={f.valor || 'todos'} href={`/crm/prospectos?estado=${f.valor}`}
                className={`rounded-full border px-3 py-1 ${estado === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
                {f.texto}
              </Link>
            ))}
          </nav>
          <form className="flex gap-2 text-sm">
            <input type="hidden" name="estado" value={estado} />
            <input name="q" defaultValue={sp.q ?? ''} placeholder="Buscar por RIF o nombre" className="campo" />
            <button className="rounded-lg border border-borde bg-white/5 px-3 py-2 hover:bg-white/10">Buscar</button>
          </form>
        </div>
        <Tabla columnas={['RIF', 'Prospecto', 'Vendedor', 'Origen', { t: 'Oportunidades abiertas', derecha: true }, 'Última actividad', 'Registrado', 'Estado']}
          vacio="No hay prospectos con ese filtro.">
          {filas.map((p) => (
            <tr key={p.id} className="hover:bg-white/[0.03]">
              <Celda mono>{p.rif}</Celda>
              <Celda><Link href={`/crm/terceros/${p.id}`} className="text-acento hover:underline">{p.razon_social}</Link></Celda>
              <Celda className="text-texto-2">{p.vendedor}</Celda>
              <Celda className="text-texto-2">{p.origen ?? '—'}</Celda>
              <Celda derecha mono>{p.oportunidades_abiertas}</Celda>
              <Celda className="text-texto-2">{p.ultima_actividad ?? 'Ninguna'}</Celda>
              <Celda className="text-texto-2">{p.creado}</Celda>
              <Celda><Etiqueta tono={TONO[p.estado as keyof typeof TONO]}>{p.estado === 'activo' ? 'Activo' : p.estado === 'convertido' ? 'Cliente' : 'Descartado'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
