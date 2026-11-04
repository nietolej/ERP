import { BotonEnviar, Formulario } from '@/components/formulario';
import { Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { NOMBRE_UNIDAD, PARAMETROS_OPCIONALES, ROLES_PARAMETROS, listarParametros, type Parametro } from '@/lib/maestros/parametros-reportes';
import { actualizarParametroAccion } from './acciones';

function Fila({ p }: { p: Parametro }) {
  return (
    <tr>
      <Celda mono className="whitespace-nowrap">{p.codigo}</Celda>
      <Celda className="text-texto-2">{p.descripcion}</Celda>
      <Celda>
        <Formulario accion={actualizarParametroAccion} className="flex items-center gap-2">
          <input type="hidden" name="tabla" value={p.tabla} />
          <input type="hidden" name="codigo" value={p.codigo} />
          <input name="valor" defaultValue={Number(p.valor).toString().replace('.', ',')} inputMode="decimal" required aria-label={`Valor de ${p.codigo}`}
            className="campo w-28 text-right" />
          <span className="w-28 text-xs text-texto-2">{NOMBRE_UNIDAD[p.unidad] ?? p.unidad}</span>
          <BotonEnviar variante="secundario">Guardar</BotonEnviar>
        </Formulario>
      </Celda>
    </tr>
  );
}

export default async function ParametrosReportesPage() {
  await exigirRol(...ROLES_PARAMETROS);
  const parametros = await listarParametros(await getDb());
  const faltantes = PARAMETROS_OPCIONALES.filter((o) => !parametros.some((p) => p.tabla === o.tabla && p.codigo === o.codigo));

  return (
    <>
      <Encabezado titulo="Parámetros de reportes e inventario"
        descripcion="Umbrales y tamaños que usan los reportes. Los valores iniciales son de referencia: ajústelos con datos reales. Cada cambio queda en la auditoría y se aplica de inmediato." />
      <Panel titulo="Reportes">
        <Tabla columnas={['Código', 'Qué controla', 'Valor']}>
          {parametros.filter((p) => p.tabla === 'reporte').map((p) => <Fila key={p.codigo} p={p} />)}
        </Tabla>
      </Panel>
      <Panel titulo="Inventario (disponibilidad, velocidad de venta y sugerido de compra)" className="mt-5">
        <Tabla columnas={['Código', 'Qué controla', 'Valor']}>
          {parametros.filter((p) => p.tabla === 'inventario').map((p) => <Fila key={p.codigo} p={p} />)}
        </Tabla>
      </Panel>
      <Panel titulo="Conciliación bancaria" className="mt-5">
        <Tabla columnas={['Código', 'Qué controla', 'Valor']}>
          {parametros.filter((p) => p.tabla === 'conciliacion').map((p) => <Fila key={p.codigo} p={p} />)}
        </Tabla>
      </Panel>
      {faltantes.length > 0 && (
        <Panel titulo="Opcionales sin cargar" className="mt-5">
          <p className="mb-3 text-sm text-texto-2">Mientras no tengan valor, lo que depende de ellos no se muestra en los reportes.</p>
          <Tabla columnas={['Código', 'Qué controla', 'Valor']}>
            {faltantes.map((o) => <Fila key={o.codigo} p={{ ...o, valor: '' }} />)}
          </Tabla>
        </Panel>
      )}
    </>
  );
}
