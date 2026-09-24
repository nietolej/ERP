import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas } from '@/lib/formato';
import { nuevaVigencia, validarParametro } from '../acciones';

interface Param {
  id: string; codigo: string; descripcion: string; valor: string; unidad: string;
  vigente_desde: string; vigente_hasta: string | null; fuente_normativa: string | null; validado_por_contador: boolean;
}

const UNIDAD: Record<string, string> = { porcentaje: '%', bolivares: 'Bs', dias: 'días', factor: '×' };

export default async function ParametrosFiscalesPage() {
  const u = await exigirRol('contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor');
  const esContador = tieneRol(u, ['contabilidad']);
  const db = await getDb();
  const { rows } = await db.query<Param>('select * from parametro_fiscal order by codigo, vigente_desde desc');
  const pendientes = rows.filter((r) => !r.validado_por_contador).length;
  const codigos = [...new Set(rows.map((r) => r.codigo))];

  return (
    <>
      <Encabezado titulo="Parámetros fiscales" descripcion="Alícuotas, porcentajes y valores con vigencia por fecha. Nada de esto está escrito en el código (§3.5)." />
      {pendientes > 0 && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            {pendientes} parámetro(s) cargados como referencia (§11.2) están pendientes de validación por el contador.
            La normativa cambia por providencia: confirme cada valor antes del arranque.
          </Aviso>
        </div>
      )}
      <Panel titulo="Parámetros y vigencias">
        <Tabla columnas={['Código', 'Descripción', { t: 'Valor', derecha: true }, 'Vigencia', 'Fuente normativa', 'Estado']}>
          {rows.map((p) => (
            <tr key={p.id}>
              <Celda mono>{p.codigo}</Celda>
              <Celda>{p.descripcion}</Celda>
              <Celda derecha mono>{p.valor.replace(/\.?0+$/, '')} {UNIDAD[p.unidad]}</Celda>
              <Celda>{fecha(p.vigente_desde)} → {p.vigente_hasta ? fecha(p.vigente_hasta) : 'vigente'}</Celda>
              <Celda className="text-texto-2">{p.fuente_normativa ?? '—'}</Celda>
              <Celda>
                {p.validado_por_contador ? <Etiqueta tono="exito">Validado</Etiqueta> : esContador ? (
                  <Formulario accion={validarParametro}>
                    <input type="hidden" name="id" value={p.id} />
                    <BotonEnviar variante="secundario">Marcar validado</BotonEnviar>
                  </Formulario>
                ) : <Etiqueta tono="advertencia">Pendiente</Etiqueta>}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {esContador && (
        <Panel titulo="Registrar un cambio de valor (nueva vigencia)" className="mt-5">
          <p className="mb-4 text-sm text-texto-2">
            La vigencia actual se cierra el día anterior a la nueva fecha. Los documentos ya emitidos conservan el valor con el que se emitieron.
          </p>
          <Formulario accion={nuevaVigencia} className="grid gap-3 md:grid-cols-4">
            <Campo etiqueta="Parámetro">
              <select name="codigo" className="campo">{codigos.map((c) => <option key={c}>{c}</option>)}</select>
            </Campo>
            <Campo etiqueta="Nuevo valor"><input name="valor" inputMode="decimal" required className="campo" /></Campo>
            <Campo etiqueta="Vigente desde"><input type="date" name="vigente_desde" required defaultValue={hoyCaracas()} className="campo" /></Campo>
            <Campo etiqueta="Fuente normativa"><input name="fuente_normativa" placeholder="Gaceta / providencia" className="campo" /></Campo>
            <div><BotonEnviar>Registrar vigencia</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
