import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';

const CONTROL: Record<string, string> = {
  cxc: 'Auxiliar de CxC', cxp: 'Auxiliar de CxP', inventario: 'Auxiliar de inventario',
  banco: 'Bancos', comisiones: 'Comisiones', apertura: 'Solo arranque',
};

export default async function PlanDeCuentasPage() {
  await exigirRol('contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor');
  const db = await getDb();
  const { rows } = await db.query<{
    codigo: string; nombre: string; tipo: string; naturaleza: string; imputable: boolean; controlada_por: string | null; activa: boolean;
  }>('select codigo, nombre, tipo, naturaleza, imputable, controlada_por, activa from cuenta_contable order by string_to_array(codigo, \'.\')::int[]');

  return (
    <>
      <Encabezado titulo="Plan de cuentas" descripcion="Estructura base (§12.1). Las cuentas de agrupación no reciben movimientos." />
      <div className="mb-5">
        <Aviso tono="advertencia">Estructura inicial propuesta: debe revisarla y aprobarla el contador antes del arranque. Las cuentas bancarias se agregan al registrar cada banco.</Aviso>
      </div>
      <Panel>
        <Tabla columnas={['Código', 'Cuenta', 'Tipo', 'Naturaleza', 'Uso']}>
          {rows.map((c) => {
            const nivel = c.codigo.split('.').length - 1;
            return (
              <tr key={c.codigo} className={c.imputable ? '' : 'bg-white/[0.03]'}>
                <Celda mono>{c.codigo}</Celda>
                <Celda className={c.imputable ? '' : 'font-semibold'}>
                  <span style={{ paddingLeft: `${nivel * 1.1}rem` }}>{c.nombre}</span>
                </Celda>
                <Celda className="capitalize text-texto-2">{c.tipo}</Celda>
                <Celda className="text-texto-2">{c.naturaleza === 'D' ? 'Deudora' : 'Acreedora'}</Celda>
                <Celda>
                  {!c.imputable ? <span className="text-xs text-texto-2">Agrupación</span>
                    : c.controlada_por ? <Etiqueta tono="advertencia">{CONTROL[c.controlada_por]}</Etiqueta>
                    : <Etiqueta tono="info">Movimiento</Etiqueta>}
                </Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>
    </>
  );
}
