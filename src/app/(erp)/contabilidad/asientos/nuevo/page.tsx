import { Encabezado, Panel } from '@/components/ui';
import { FormularioAsiento } from '@/components/formulario-asiento';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { guardarAsiento } from '../acciones';
import { cuentasParaManual, monedasActivas } from '../datos';

export default async function NuevoAsientoPage() {
  await exigirRol('contabilidad');
  const db = await getDb();
  const [cuentas, monedas] = await Promise.all([cuentasParaManual(db), monedasActivas(db)]);
  return (
    <>
      <Encabezado titulo="Nuevo asiento manual"
        descripcion="Se guarda como borrador. Se contabiliza cuando lo aprueba el jefe de contabilidad (§3.1)." />
      <Panel>
        <FormularioAsiento accion={guardarAsiento} cuentas={cuentas} monedas={monedas}
          inicial={{ fecha: hoyCaracas(), descripcion: '', moneda: 'VES', lineas: [] }} />
      </Panel>
    </>
  );
}
