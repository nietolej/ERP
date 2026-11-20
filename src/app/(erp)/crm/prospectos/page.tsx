import { ListaProspectos } from './lista';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_CRM, ROLES_VEN_CRM, soloLoSuyo } from '@/lib/crm/comun';
import { listarProspectos } from '@/lib/crm/prospectos';
import { getDb } from '@/lib/db';
import { registrarProspectoAccion } from '../acciones';

export default async function ProspectosPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const sp = await searchParams;
  const estado = ['activo', 'convertido', 'descartado', ''].includes(sp.estado ?? '-') ? sp.estado! : 'activo';
  const db = await getDb();
  const registra = tieneRol(u, [...ROLES_CRM]);
  const [filas, vendedores] = await Promise.all([
    listarProspectos(db, u, { estado }),
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

      <ListaProspectos key={estado} iniciales={filas} estadoInicial={estado} />
    </>
  );
}
