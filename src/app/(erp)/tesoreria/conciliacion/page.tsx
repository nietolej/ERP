import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { NOMBRE_MES, ROLES_CONCILIAN, ROLES_VEN_CONCILIACION, cuentasConciliables, listarExtractos } from '@/lib/tesoreria/conciliacion';
import { crearExtractoAccion } from './acciones';

export default async function ConciliacionPage() {
  const u = await exigirRol(...ROLES_VEN_CONCILIACION);
  const db = await getDb();
  const [extractos, cuentas] = await Promise.all([listarExtractos(db), cuentasConciliables(db)]);
  const hoy = new Date();
  const periodo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;

  return (
    <>
      <Encabezado titulo="Conciliación bancaria"
        descripcion="Cada mes y cuenta se concilia contra el mayor: Tesorería empareja las líneas del banco con los asientos y Contabilidad o Gerencia, distinta de quien emparejó, cierra el mes." />
      <Panel>
        <Tabla columnas={['Mes', 'Cuenta', { t: 'Movimientos', derecha: true }, { t: 'Sin conciliar', derecha: true }, { t: 'Saldo del banco', derecha: true }, 'Estado']} vacio="Todavía no se ha cargado ningún extracto.">
          {extractos.map((e) => (
            <tr key={e.id} className="hover:bg-white/[0.03]">
              <Celda><Link href={`/tesoreria/conciliacion/${e.id}`} className="text-acento hover:underline">{NOMBRE_MES[e.mes - 1]} {e.anio}</Link></Celda>
              <Celda>{e.cuenta}</Celda>
              <Celda derecha mono>{e.lineas}</Celda>
              <Celda derecha mono>{e.pendientes}</Celda>
              <Celda derecha mono>{e.moneda} {monto(e.saldo_final)}</Celda>
              <Celda><Etiqueta tono={e.estado === 'cerrado' ? 'exito' : 'advertencia'}>{e.estado === 'cerrado' ? 'cerrado' : 'abierto'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {tieneRol(u, ROLES_CONCILIAN) && (
        <Panel titulo="Cargar el extracto de un mes" className="mt-5">
          <Formulario accion={crearExtractoAccion} className="grid gap-4 sm:grid-cols-4">
            <Campo etiqueta="Cuenta bancaria">
              <select name="cuenta_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {cuentas.map((c) => <option key={c.id} value={c.id}>{c.texto}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Mes"><input type="month" name="periodo" required defaultValue={periodo} className="campo" /></Campo>
            <Campo etiqueta="Saldo inicial del banco"><input name="saldo_inicial" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
            <Campo etiqueta="Saldo final del banco"><input name="saldo_final" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
            <div className="sm:col-span-4"><BotonEnviar>Crear extracto</BotonEnviar></div>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Después se cargan los movimientos del estado de cuenta (CSV del banco o a mano). Se concilian los meses en orden.</p>
        </Panel>
      )}
    </>
  );
}
