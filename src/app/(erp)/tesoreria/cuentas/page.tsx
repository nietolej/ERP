import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import {
  NOMBRE_TIPO_CUENTA, ROLES_GESTIONAN_CUENTAS, ROLES_VEN_CUENTAS, TIPOS_CUENTA, buscarCuentasBancarias,
} from '@/lib/maestros/cuentas-bancarias';
import { actualizarCuentaAccion, crearCuentaAccion } from '../acciones';

export default async function CuentasBancariasPage() {
  const u = await exigirRol(...ROLES_VEN_CUENTAS);
  const db = await getDb();
  const puedeGestionar = tieneRol(u, [...ROLES_GESTIONAN_CUENTAS]);
  const [cuentas, bancos, monedas] = await Promise.all([
    buscarCuentasBancarias(db),
    puedeGestionar ? db.query<{ id: string; nombre: string }>('select id, nombre from banco where activo order by nombre') : Promise.resolve({ rows: [] }),
    puedeGestionar ? db.query<{ codigo: string; nombre: string }>('select codigo, nombre from moneda order by codigo') : Promise.resolve({ rows: [] }),
  ]);

  return (
    <>
      <Encabezado titulo="Cuentas bancarias y caja"
        descripcion="Donde entra el dinero de los cobros. Cada cuenta tiene su subcuenta contable propia; el saldo es el del mayor." />
      <Panel>
        <Tabla columnas={['Código', 'Cuenta', 'Tipo', 'Banco', 'Subcuenta', { t: 'Saldo Bs', derecha: true }, { t: 'Saldo USD', derecha: true }, 'Estado', '']}
          vacio="Aún no hay cuentas. Registre el banco en Maestros → Bancos y luego la cuenta aquí.">
          {cuentas.map((c) => (
            <tr key={c.id} className="align-top">
              <Celda mono>{c.codigo}</Celda>
              <Celda>{c.nombre}{c.numero && <span className="block text-xs text-texto-2">{c.numero} · {c.moneda}</span>}</Celda>
              <Celda className="text-texto-2">{NOMBRE_TIPO_CUENTA[c.tipo]}</Celda>
              <Celda className="text-texto-2">{c.banco ?? '—'}</Celda>
              <Celda mono className="text-texto-2">{c.cuenta_contable}</Celda>
              <Celda derecha>{monto(c.saldo_ves, 'Bs. ')}</Celda>
              <Celda derecha>{monto(c.saldo_usd, 'US$ ')}</Celda>
              <Celda><Etiqueta tono={c.activa ? 'exito' : 'info'}>{c.activa ? 'activa' : 'inactiva'}</Etiqueta></Celda>
              <Celda>
                {puedeGestionar && (
                  <details>
                    <summary className="cursor-pointer text-xs text-acento hover:underline">Editar</summary>
                    <Formulario accion={actualizarCuentaAccion} className="mt-2 flex items-end gap-2">
                      <input type="hidden" name="id" value={c.id} />
                      <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} defaultValue={c.nombre} className="campo" /></Campo>
                      <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="activa" defaultChecked={c.activa} /> Activa</label>
                      <BotonEnviar variante="secundario">Guardar</BotonEnviar>
                    </Formulario>
                  </details>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {puedeGestionar && (
        <Panel titulo="Nueva cuenta" className="mt-5">
          <Formulario accion={crearCuentaAccion} className="grid gap-3 md:grid-cols-3 md:items-end">
            <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} placeholder="Banco Nacional Bs" className="campo" /></Campo>
            <Campo etiqueta="Tipo">
              <select name="tipo" required defaultValue="banco" className="campo">{TIPOS_CUENTA.map((t) => <option key={t} value={t}>{NOMBRE_TIPO_CUENTA[t]}</option>)}</select>
            </Campo>
            <Campo etiqueta="Moneda" ayuda="Es la moneda de los cobros que entran a esta cuenta.">
              <select name="moneda" required defaultValue="VES" className="campo">{monedas.rows.map((m) => <option key={m.codigo} value={m.codigo}>{m.codigo} · {m.nombre}</option>)}</select>
            </Campo>
            <Campo etiqueta="Banco" ayuda="Obligatorio para un banco nacional.">
              <select name="banco_id" defaultValue="" className="campo"><option value="">— Ninguno —</option>{bancos.rows.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}</select>
            </Campo>
            <Campo etiqueta="Número de cuenta"><input name="numero" maxLength={40} className="campo font-mono" /></Campo>
            <div className="md:text-right"><BotonEnviar>Registrar cuenta</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
