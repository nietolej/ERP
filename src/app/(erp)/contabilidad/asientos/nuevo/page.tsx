import { Aviso, Encabezado, Panel } from '@/components/ui';
import { FormularioAsiento } from '@/components/formulario-asiento';
import { estadoArranque } from '@/lib/apertura/apertura';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { guardarAsiento } from '../acciones';
import { cuentasParaApertura, cuentasParaManual, monedasActivas } from '../datos';

export default async function NuevoAsientoPage({ searchParams }: { searchParams: Promise<{ tipo?: string }> }) {
  await exigirRol('contabilidad');
  const { tipo } = await searchParams;
  const apertura = tipo === 'apertura';
  const db = await getDb();
  const [cuentas, monedas, arranque] = await Promise.all([apertura ? cuentasParaApertura(db) : cuentasParaManual(db), monedasActivas(db), estadoArranque(db)]);
  const bloqueada = apertura && (!arranque.fecha || arranque.cerrada);
  return (
    <>
      <Encabezado titulo={apertura ? 'Asiento de apertura' : 'Nuevo asiento manual'}
        descripcion={apertura
          ? 'El resto del balance inicial (patrimonio, activos fijos, anticipos, impuestos, préstamos) contra «Saldos de apertura», con la fecha de arranque. Bancos, cuentas por cobrar y por pagar entran con sus documentos de apertura. Lo aprueba el jefe de contabilidad.'
          : 'Se guarda como borrador. Se contabiliza cuando lo aprueba el jefe de contabilidad (§3.1).'} />
      {bloqueada ? (
        <Aviso tono="advertencia">{!arranque.fecha ? 'Gerencia debe fijar primero la fecha de arranque.' : 'La apertura ya está cerrada.'}</Aviso>
      ) : (
        <Panel>
          <FormularioAsiento accion={guardarAsiento} cuentas={cuentas} monedas={monedas} tipo={apertura ? 'apertura' : undefined}
            inicial={{ fecha: apertura && arranque.fecha ? arranque.fecha : hoyCaracas(), descripcion: apertura ? 'Asiento de apertura' : '', moneda: 'VES', lineas: [] }} />
        </Panel>
      )}
    </>
  );
}
