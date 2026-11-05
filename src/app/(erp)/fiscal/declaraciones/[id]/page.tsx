import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Etiqueta, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { NOMBRE_DECLARACION, detalleDeclaracion } from '@/lib/fiscal/declaraciones';
import { ROLES_VEN_LIBROS } from '@/lib/fiscal/libros';
import { fecha, monto } from '@/lib/formato';
import { reabrirAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ETIQUETAS: Record<string, string> = {
  baseVentas: 'Base de ventas', debito: 'Débito fiscal', baseCompras: 'Base de compras', credito: 'Crédito fiscal', excedenteAnterior: 'Excedente del mes anterior',
  retencionesSoportadas: 'Retenciones de IVA soportadas', resultado: 'Resultado (débito − crédito − excedente)', cuotaPagar: 'Cuota tributaria a pagar', excedenteSiguiente: 'Excedente que se traslada',
  comprobantes: 'Comprobantes', baseVes: 'Base (Bs.)', retenidoVes: 'Retenido (Bs.)', pendientes: 'Retenciones sin comprobante', ajustesPorNotas: 'Ajustes por notas de crédito, sin numerar (Bs.)',
};

export default async function DeclaracionPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_LIBROS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const d = await detalleDeclaracion(await getDb(), id);
  if (!d) notFound();
  const q = d.quincena ? ` · ${d.quincena === 1 ? 'primera' : 'segunda'} quincena` : '';

  return (
    <>
      <Encabezado titulo={NOMBRE_DECLARACION[d.tipo]} descripcion={`${fecha(d.desde)} al ${fecha(d.hasta)}${q}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={d.reabierta ? 'peligro' : 'exito'}>{d.reabierta ? 'reabierta' : 'vigente'}</Etiqueta>
          <Link href="/fiscal/declaraciones" className="text-sm text-texto-2 hover:text-texto">← Declaraciones</Link>
        </div>
      </Encabezado>
      {d.reabierta && <div className="mb-5"><Aviso tono="peligro">Reabierta por {d.reabierta_por}: {d.reabierta_motivo}. El periodo admite documentos de nuevo y se puede declarar otra vez; esta foto se conserva.</Aviso></div>}
      <Panel titulo="Cifras declaradas">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
          {Object.entries(d.cifras).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-borde py-1">
              <dt className="text-texto-2">{ETIQUETAS[k] ?? k}</dt>
              <dd className="font-mono">{k === 'comprobantes' || k === 'pendientes' ? String(v) : monto(String(v))}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-texto-2">Declarada por {d.declarada_por} el {d.declarada}.</p>
      </Panel>
      {d.archivo_nombre && (
        <Panel titulo="Archivo" className="mt-5">
          <a href={`/api/fiscal/declaraciones/${d.id}/archivo`} className="text-acento hover:underline">Descargar {d.archivo_nombre}</a>
          <p className="mt-2 text-xs text-texto-2">Es el archivo tal como se declaró. Su formato es un borrador: el contador debe validarlo antes de subirlo al portal.</p>
          <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-borde p-3 text-xs">{d.archivo?.slice(0, 4000)}</pre>
        </Panel>
      )}
      {tieneRol(u, ['gerencia']) && !d.reabierta && (
        <Panel titulo="Reabrir el periodo" className="mt-5">
          <Formulario accion={reabrirAccion} className="grid gap-3 sm:grid-cols-[2fr_auto] sm:items-end">
            <input type="hidden" name="id" value={d.id} />
            <Campo etiqueta="Motivo (queda auditado)"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo>
            <BotonEnviar variante="peligro">Reabrir</BotonEnviar>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Un IVA no se reabre si el mes siguiente ya está declarado: su excedente de crédito fiscal depende de este.</p>
        </Panel>
      )}
    </>
  );
}
