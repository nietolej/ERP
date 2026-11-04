import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_CATEGORIAS, ROLES_VEN_GASTOS, centrosDeCosto, cuentasDeGasto, listarCategorias } from '@/lib/gastos/gastos';
import { actualizarCategoriaAccion, crearCategoriaAccion, estadoCategoriaAccion } from '../acciones';

export default async function CategoriasGastoPage() {
  const u = await exigirRol(...ROLES_VEN_GASTOS);
  const db = await getDb();
  const edita = tieneRol(u, ROLES_CATEGORIAS);
  const [categorias, cuentas, centros] = await Promise.all([listarCategorias(db), cuentasDeGasto(db), centrosDeCosto(db)]);

  return (
    <>
      <Encabezado titulo="Categorías de gasto"
        descripcion="Cada categoría lleva su cuenta contable de gasto, su centro de costo (opcional) y si el IVA es crédito fiscal. Un cambio aplica a los gastos que se registren desde ahora.">
        <Link href="/gastos" className="text-sm text-texto-2 hover:text-texto">← Gastos</Link>
      </Encabezado>
      <Panel>
        <Tabla columnas={['Código', 'Nombre', 'Cuenta contable', 'Centro de costo', 'IVA', 'Estado', '']} vacio="Sin categorías.">
          {categorias.map((c) => (
            <tr key={c.id}>
              <Celda mono>{c.codigo}</Celda>
              <Celda>{c.nombre}</Celda>
              <Celda className="text-texto-2">{c.cuenta}</Celda>
              <Celda className="text-texto-2">{c.centro_costo ?? '—'}</Celda>
              <Celda>{c.iva_deducible ? 'Crédito fiscal' : 'Al gasto'}</Celda>
              <Celda><Etiqueta tono={c.activa ? 'exito' : 'info'}>{c.activa ? 'activa' : 'inactiva'}</Etiqueta></Celda>
              <Celda>
                {edita && (
                  <details>
                    <summary className="cursor-pointer text-xs text-texto-2 hover:text-texto">Editar</summary>
                    <Formulario accion={actualizarCategoriaAccion} className="mt-2 space-y-2">
                      <input type="hidden" name="id" value={c.id} />
                      <input name="nombre" defaultValue={c.nombre} required minLength={3} className="campo" aria-label="Nombre" />
                      <select name="cuenta_id" defaultValue={c.cuenta_id} className="campo" aria-label="Cuenta contable">
                        {cuentas.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}
                      </select>
                      <select name="centro_costo_id" defaultValue={c.centro_costo_id ?? ''} className="campo" aria-label="Centro de costo">
                        <option value="">Sin centro de costo</option>
                        {centros.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}
                      </select>
                      <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="iva_deducible" value="1" defaultChecked={c.iva_deducible} className="h-4 w-4" /> El IVA es crédito fiscal</label>
                      <BotonEnviar>Guardar</BotonEnviar>
                    </Formulario>
                    <Formulario accion={estadoCategoriaAccion} className="mt-2">
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="activa" value={c.activa ? '0' : '1'} />
                      <BotonEnviar variante={c.activa ? 'peligro' : undefined}>{c.activa ? 'Inactivar' : 'Activar'}</BotonEnviar>
                    </Formulario>
                  </details>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {edita && (
        <Panel titulo="Nueva categoría" className="mt-5">
          <Formulario accion={crearCategoriaAccion} className="grid gap-4 sm:grid-cols-3">
            <Campo etiqueta="Código" ayuda="Letras mayúsculas, números y guion bajo."><input name="codigo" required maxLength={30} className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="Nombre"><input name="nombre" required minLength={3} className="campo" /></Campo>
            <Campo etiqueta="Cuenta contable de gasto" ayuda="Si falta la cuenta, créela antes en el plan de cuentas.">
              <select name="cuenta_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {cuentas.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Centro de costo (opcional)">
              <select name="centro_costo_id" defaultValue="" className="campo">
                <option value="">Sin centro de costo</option>
                {centros.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}
              </select>
            </Campo>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="iva_deducible" value="1" defaultChecked className="h-4 w-4" /> El IVA de estos gastos es crédito fiscal</label>
            <div className="sm:col-span-3"><BotonEnviar>Crear categoría</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
