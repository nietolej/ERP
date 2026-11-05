import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Etiqueta, Panel } from '@/components/ui';
import { ROLES_CONFIRMAN, ROLES_VEN_CHECKLIST, checklist, type Confirmacion } from '@/lib/apertura/checklist';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { confirmarAccion, retirarAccion } from './acciones';

const NOMBRE_ROLES: Record<string, string> = {
  contabilidad: 'Contabilidad', jefe_contabilidad: 'Jefe de contabilidad', gerencia: 'Gerencia', tesoreria: 'Tesorería', administrador: 'Administrador',
};
const quien = (roles: readonly string[]) => roles.map((r) => NOMBRE_ROLES[r] ?? r).join(' o ');

function Confirmar({ codigo, etiqueta, puede }: { codigo: string; etiqueta: string; puede: boolean }) {
  if (!puede) return <p className="text-xs text-texto-2">Lo confirma {quien(ROLES_CONFIRMAN[codigo as keyof typeof ROLES_CONFIRMAN])}.</p>;
  return (
    <Formulario accion={confirmarAccion} className="mt-2 flex flex-wrap items-end gap-3">
      <input type="hidden" name="codigo" value={codigo} />
      <Campo etiqueta="Nota (opcional)"><input name="nota" maxLength={200} className="campo" /></Campo>
      <BotonEnviar>{etiqueta}</BotonEnviar>
    </Formulario>
  );
}

function Retirar({ c }: { c: Confirmacion }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-texto-2 hover:text-texto">Retirar la confirmación</summary>
      <Formulario accion={retirarAccion} className="mt-2 flex flex-wrap items-end gap-3">
        <input type="hidden" name="id" value={c.id} />
        <Campo etiqueta="Motivo (queda auditado)"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo>
        <BotonEnviar variante="peligro">Retirar</BotonEnviar>
      </Formulario>
    </details>
  );
}

export default async function ArranquePage() {
  const u = await exigirRol(...ROLES_VEN_CHECKLIST);
  const c = await checklist(await getDb());
  const esGerencia = tieneRol(u, ['gerencia']);
  const hechos = c.puntos.filter((p) => p.listo).length;

  return (
    <>
      <Encabezado titulo="Checklist de arranque"
        descripcion="Lo que debe estar en orden antes de operar solo en el ERP (§14.6). El sistema comprueba solo lo que puede; lo que depende de una persona lo confirma su responsable. Al final firman Gerencia y el contador.">
        <Link href="/configuracion/apertura" className="text-sm text-texto-2 hover:text-texto">Apertura →</Link>
      </Encabezado>
      <div className="mb-5">
        {c.firmado
          ? <Aviso tono="exito">Arranque firmado por {c.firmas.gerencia!.por} (Gerencia) el {c.firmas.gerencia!.el} y por {c.firmas.contador!.por} (contador) el {c.firmas.contador!.el}.</Aviso>
          : <Aviso tono={c.todoListo ? 'info' : 'advertencia'}>{hechos} de {c.puntos.length} puntos en orden.{c.todoListo ? ' Ya pueden firmar Gerencia y el contador.' : ' Faltan los que siguen marcados como pendientes.'}</Aviso>}
      </div>

      <div className="space-y-4">
        {c.puntos.map((p) => (
          <Panel key={p.codigo}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className="max-w-2xl text-sm font-semibold">{p.titulo}</h2>
              <Etiqueta tono={p.listo ? 'exito' : 'advertencia'}>{p.listo ? 'en orden' : 'pendiente'}</Etiqueta>
            </div>
            {p.automatico && (
              <p className={`mt-2 text-sm ${p.automatico.ok ? 'text-emerald-300' : 'text-texto-2'}`}>
                <span className="font-semibold">{p.automatico.ok ? '✓ ' : '· '}</span>{p.automatico.detalle}
              </p>
            )}
            {p.confirmacion && (
              p.confirmacion.hecha ? (
                <div className="mt-2 text-sm">
                  <p><span className="font-semibold text-emerald-300">✓ </span>Confirmado por {p.confirmacion.hecha.por} el {p.confirmacion.hecha.el}{p.confirmacion.hecha.nota ? `: ${p.confirmacion.hecha.nota}` : ''}.</p>
                  {esGerencia && <Retirar c={p.confirmacion.hecha} />}
                </div>
              ) : (
                <div className="mt-2">
                  <p className="text-sm text-texto-2">· Falta la confirmación de {quien(p.confirmacion.roles)}.</p>
                  <Confirmar codigo={p.confirmacion.codigo} etiqueta="Confirmar" puede={tieneRol(u, [...p.confirmacion.roles] as never)} />
                </div>
              )
            )}
            {p.enlace && <p className="mt-2 text-xs"><Link href={p.enlace.href} className="text-acento hover:underline">{p.enlace.texto} →</Link></p>}
          </Panel>
        ))}

        <Panel titulo="Firmas del arranque">
          <div className="grid gap-5 md:grid-cols-2">
            {([['firma_gerencia', 'Gerencia', c.firmas.gerencia], ['firma_contador', 'Contador (Contabilidad o Jefe de contabilidad)', c.firmas.contador]] as const).map(([codigo, nombre, f]) => (
              <div key={codigo}>
                <h3 className="text-sm font-semibold">{nombre}</h3>
                {f ? (
                  <div className="mt-1 text-sm">
                    <p><span className="font-semibold text-emerald-300">✓ </span>Firmó {f.por} el {f.el}{f.nota ? `: ${f.nota}` : ''}.</p>
                    {esGerencia && <Retirar c={f} />}
                  </div>
                ) : c.todoListo ? (
                  <Confirmar codigo={codigo} etiqueta="Firmar" puede={tieneRol(u, [...ROLES_CONFIRMAN[codigo]] as never)} />
                ) : (
                  <p className="mt-1 text-sm text-texto-2">Se puede firmar cuando todos los puntos estén en orden.</p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-texto-2">Si después se retira una confirmación, las firmas ya dadas se retiran también y hay que firmar de nuevo.</p>
        </Panel>
      </div>
    </>
  );
}
