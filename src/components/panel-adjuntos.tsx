import { anularAdjuntoAccion, subirAdjuntoAccion } from '@/app/(erp)/adjuntos/acciones';
import { listarAdjuntos, MAX_BYTES_ADJUNTO, puedeAgregarAdjuntos, type TipoAdjuntable } from '@/lib/adjuntos/adjuntos';
import { getDb } from '@/lib/db';
import { fechaHora } from '@/lib/formato';
import { BotonEnviar, Formulario } from './formulario';
import { Campo, Celda, Etiqueta, Panel, Tabla } from './ui';

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const TIPO_LEGIBLE = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP' } as const;

/**
 * Adjuntos de un registro (§4.2). El llamador ya verificó que el usuario puede ver el registro.
 * Los anulados solo se listan a Gerencia y Auditor, que son quienes pueden abrirlos.
 */
export async function PanelAdjuntos({ tipo, entidadId, usuario, className }: {
  tipo: TipoAdjuntable; entidadId: string; usuario: { id: string; roles: readonly string[] }; className?: string;
}) {
  const db = await getDb();
  const veAnulados = usuario.roles.some((r) => r === 'gerencia' || r === 'auditor');
  const [adjuntos, puedeAgregar] = await Promise.all([
    listarAdjuntos(db, tipo, entidadId, veAnulados),
    puedeAgregarAdjuntos(db, usuario, tipo, entidadId),
  ]);
  const esGerencia = usuario.roles.includes('gerencia');

  return (
    <Panel titulo="Adjuntos" className={className}>
      <Tabla columnas={['Archivo', 'Tipo', { t: 'Tamaño', derecha: true }, 'Subido por', 'Estado', '']} vacio="Sin archivos adjuntos.">
        {adjuntos.map((a) => {
          const anulado = a.anulado_at !== null;
          return (
            <tr key={a.id}>
              <Celda>
                <a href={`/api/adjuntos/${a.id}`} target="_blank" rel="noopener noreferrer" className="text-acento hover:underline">{a.nombre}</a>
                {a.descripcion && <p className="text-xs text-texto-2">{a.descripcion}</p>}
              </Celda>
              <Celda className="text-texto-2">{TIPO_LEGIBLE[a.tipo_contenido]}</Celda>
              <Celda derecha mono>{kb(a.tamano_bytes)}</Celda>
              <Celda className="text-texto-2">{a.autor} · {fechaHora(a.created_at)}</Celda>
              <Celda>
                {anulado
                  ? <span title={a.motivo_anulacion ?? undefined}><Etiqueta tono="peligro">anulado</Etiqueta></span>
                  : <Etiqueta tono="exito">vigente</Etiqueta>}
              </Celda>
              <Celda>
                {!anulado && (esGerencia || a.subido_por === usuario.id) && (
                  <details>
                    <summary className="cursor-pointer text-xs text-texto-2 hover:text-texto">Anular</summary>
                    <Formulario accion={anularAdjuntoAccion} className="mt-2 space-y-2">
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="tipo" value={tipo} />
                      <input type="hidden" name="entidad_id" value={entidadId} />
                      <input name="motivo" required minLength={3} maxLength={200} placeholder="Motivo" aria-label="Motivo de la anulación" className="campo" />
                      <BotonEnviar variante="peligro">Anular adjunto</BotonEnviar>
                    </Formulario>
                  </details>
                )}
              </Celda>
            </tr>
          );
        })}
      </Tabla>

      {puedeAgregar && (
        <Formulario accion={subirAdjuntoAccion} className="mt-5 grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <input type="hidden" name="tipo" value={tipo} />
          <input type="hidden" name="entidad_id" value={entidadId} />
          <Campo etiqueta={`Archivo (PDF, PNG, JPG o WebP, hasta ${MAX_BYTES_ADJUNTO / 1024 / 1024} MB)`}>
            <input type="file" name="archivo" accept=".pdf,.png,.jpg,.jpeg,.webp" required className="campo" />
          </Campo>
          <Campo etiqueta="Descripción (opcional)"><input name="descripcion" maxLength={300} className="campo" /></Campo>
          <BotonEnviar>Adjuntar</BotonEnviar>
        </Formulario>
      )}
    </Panel>
  );
}
