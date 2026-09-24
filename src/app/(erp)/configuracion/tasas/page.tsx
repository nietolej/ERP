import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, fechaHora, hoyCaracas, tasa } from '@/lib/formato';
import { registrarTasa } from '../acciones';

export default async function TasasPage() {
  const u = await exigirRol('tesoreria', 'contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor');
  const puedeRegistrar = tieneRol(u, ['tesoreria', 'contabilidad']);
  const db = await getDb();
  const hoy = hoyCaracas();
  const { rows } = await db.query<{ fecha: string; moneda: string; fuente: string; tasa: string; nombre: string | null; created_at: Date }>(
    `select t.fecha, t.moneda, t.fuente, t.tasa, u.nombre, t.created_at
       from tasa_cambio t left join usuario u on u.id = t.registrado_por
      order by t.fecha desc, t.moneda, t.fuente limit 60`);
  const hayHoy = rows.some((r) => r.fecha === hoy && r.moneda === 'USD' && r.fuente === 'BCV');

  return (
    <>
      <Encabezado titulo="Tasas de cambio" descripcion="Bolívares por unidad de moneda. La tasa BCV es la única válida para registros legales (§3.4)." />
      {!hayHoy && (
        <div className="mb-5">
          <Aviso tono="advertencia">No hay tasa BCV del USD registrada para hoy ({fecha(hoy)}). Sin ella no se pueden emitir documentos con fecha de hoy.</Aviso>
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[22rem_1fr]">
        {puedeRegistrar && (
          <Panel titulo="Registrar tasa">
            <Formulario accion={registrarTasa} className="space-y-4">
              <Campo etiqueta="Fecha"><input type="date" name="fecha" required defaultValue={hoy} className="campo" /></Campo>
              <div className="grid grid-cols-2 gap-3">
                <Campo etiqueta="Moneda">
                  <select name="moneda" className="campo" defaultValue="USD">
                    <option value="USD">USD</option><option value="EUR">EUR</option><option value="USDT">USDT</option>
                  </select>
                </Campo>
                <Campo etiqueta="Fuente">
                  <select name="fuente" className="campo" defaultValue="BCV">
                    <option value="BCV">BCV (oficial)</option><option value="PARALELO">Paralelo (solo gestión)</option>
                  </select>
                </Campo>
              </div>
              <Campo etiqueta="Tasa (Bs por unidad)" ayuda="Hasta 6 decimales. Una tasa registrada no se modifica: queda auditada.">
                <input name="tasa" inputMode="decimal" required placeholder="36.512300" className="campo" />
              </Campo>
              <BotonEnviar>Registrar</BotonEnviar>
            </Formulario>
            <p className="mt-4 text-xs text-texto-2">
              La carga automática diaria desde el BCV queda pendiente de definir la fuente de consulta (decisión 2).
            </p>
          </Panel>
        )}
        <Panel titulo="Últimas tasas registradas">
          <Tabla columnas={['Fecha', 'Moneda', 'Fuente', { t: 'Tasa', derecha: true }, 'Registrada por']} vacio="No hay tasas registradas.">
            {rows.map((r) => (
              <tr key={`${r.fecha}-${r.moneda}-${r.fuente}`}>
                <Celda>{fecha(r.fecha)}</Celda>
                <Celda>{r.moneda}</Celda>
                <Celda><Etiqueta tono={r.fuente === 'BCV' ? 'info' : 'advertencia'}>{r.fuente}</Etiqueta></Celda>
                <Celda derecha mono>{tasa(r.tasa)}</Celda>
                <Celda className="text-texto-2">{r.nombre ?? '—'} · {fechaHora(r.created_at)}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      </div>
    </>
  );
}
