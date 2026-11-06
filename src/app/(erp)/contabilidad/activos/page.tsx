import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_GESTIONAN_ACTIVOS, ROLES_VEN_ACTIVOS, listarActivos, listarCategorias } from '@/lib/contabilidad/activos';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { confirmarVidaUtilAccion, depreciarMesAccion, registrarActivoAccion } from './acciones';

const TONO = { pendiente: 'advertencia', activo: 'exito', depreciado: 'info', dado_de_baja: 'peligro', rechazado: 'peligro' } as const;

function mesPasado(): string {
  const [a, m] = hoyCaracas().split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

export default async function ActivosPage() {
  const u = await exigirRol(...ROLES_VEN_ACTIVOS);
  const db = await getDb();
  const [activos, categorias] = await Promise.all([listarActivos(db), listarCategorias(db)]);
  const puede = tieneRol(u, ROLES_GESTIONAN_ACTIVOS);
  const sinValidar = categorias.filter((c) => !c.validada_por);

  return (
    <>
      <Encabezado titulo="Activos fijos y depreciación"
        descripcion="Línea recta mensual, una sola depreciación y valor residual cero por defecto. Esta entrega da de alta los activos que ya existen al arranque; el alta desde una factura de compra queda pendiente.">
        <Link href="/contabilidad/cierre" className="text-sm text-texto-2 hover:text-texto">Cierre mensual →</Link>
      </Encabezado>
      {sinValidar.length > 0 && (
        <div className="mb-5"><Aviso tono="advertencia">La vida útil de {sinValidar.map((c) => c.nombre).join(', ')} es un valor de ejemplo: el contador debe confirmarla antes de registrar activos de esa categoría.</Aviso></div>
      )}

      <Panel titulo="Activos" className="mb-5">
        <Tabla columnas={['Código', 'Descripción', 'Categoría', 'Adquirido', { t: 'Costo (US$)', derecha: true }, { t: 'Depreciación (Bs)', derecha: true }, { t: 'En libros (Bs)', derecha: true }, 'Estado']} vacio="Todavía no hay activos fijos.">
          {activos.map((a) => (
            <tr key={a.id}>
              <Celda mono><Link href={`/contabilidad/activos/${a.id}`} className="text-acento hover:underline">{a.codigo}</Link></Celda>
              <Celda>{a.descripcion}</Celda><Celda>{a.categoria}</Celda><Celda>{fecha(a.fecha_adquisicion)}</Celda>
              <Celda derecha>{monto(a.costo_usd)}</Celda><Celda derecha>{monto(a.depreciacion_ves)}</Celda><Celda derecha>{monto(a.valor_libros_ves)}</Celda>
              <Celda><Etiqueta tono={TONO[a.estado as keyof typeof TONO] ?? 'info'}>{a.estado.replace(/_/g, ' ')}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {puede && (
        <Panel titulo="Depreciación del mes" className="mb-5">
          <Formulario accion={depreciarMesAccion} className="flex flex-wrap items-end gap-3">
            <Campo etiqueta="Mes (terminado y abierto)"><input type="month" name="periodo" defaultValue={mesPasado()} required className="campo" /></Campo>
            <BotonEnviar>Depreciar el mes</BotonEnviar>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Un asiento por mes: gasto de depreciación contra depreciación acumulada, por categoría. No se salta un mes ni se repite; la última cuota de cada activo ajusta el resto.</p>
        </Panel>
      )}

      <Panel titulo="Categorías" className="mb-5">
        <Tabla columnas={['Código', 'Categoría', 'Cuenta de activo', { t: 'Vida útil (meses)', derecha: true }, 'Confirmada por el contador', { t: 'Activos', derecha: true }, puede ? 'Confirmar o cambiar' : '']}>
          {categorias.map((c) => (
            <tr key={c.id}>
              <Celda mono>{c.codigo}</Celda><Celda>{c.nombre}</Celda><Celda mono>{c.cuenta_activo}</Celda><Celda derecha>{c.vida_util_meses}</Celda>
              <Celda>{c.validada_por ? `${c.validada_por} · ${c.validada_el}` : <Etiqueta tono="advertencia">valor de ejemplo</Etiqueta>}</Celda>
              <Celda derecha>{c.activos}</Celda>
              <Celda>
                {puede && (
                  <Formulario accion={confirmarVidaUtilAccion} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={c.id} />
                    <input type="number" name="vida" min={1} max={1200} defaultValue={c.vida_util_meses} className="campo w-24" aria-label="Vida útil en meses" />
                    <BotonEnviar variante="secundario">Confirmar</BotonEnviar>
                  </Formulario>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {puede && (
        <Panel titulo="Registrar un activo que ya existe al arranque">
          <Formulario accion={registrarActivoAccion} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Campo etiqueta="Descripción"><input name="descripcion" required minLength={3} maxLength={120} className="campo" /></Campo>
              <Campo etiqueta="Categoría"><select name="categoria_id" required className="campo">{categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre} ({c.vida_util_meses} meses)</option>)}</select></Campo>
              <Campo etiqueta="Fecha de adquisición"><input type="date" name="fecha_adquisicion" required className="campo" /></Campo>
              <Campo etiqueta="Costo (Bs)"><input name="costo_ves" required inputMode="decimal" className="campo" /></Campo>
              <Campo etiqueta="Costo (US$)"><input name="costo_usd" required inputMode="decimal" className="campo" /></Campo>
              <Campo etiqueta="Meses ya depreciados" ayuda="Cuántas cuotas lleva al arranque."><input type="number" name="meses" min={0} defaultValue={0} className="campo" /></Campo>
              <Campo etiqueta="Depreciación acumulada (Bs)"><input name="dep_ves" inputMode="decimal" placeholder="0.00" className="campo" /></Campo>
              <Campo etiqueta="Depreciación acumulada (US$)"><input name="dep_usd" inputMode="decimal" placeholder="0.00" className="campo" /></Campo>
              <Campo etiqueta="Valor residual (Bs / US$)"><div className="flex gap-2"><input name="residual_ves" inputMode="decimal" placeholder="0.00" className="campo" /><input name="residual_usd" inputMode="decimal" placeholder="0.00" className="campo" /></div></Campo>
              <Campo etiqueta="Ubicación"><input name="ubicacion" maxLength={80} className="campo" /></Campo>
              <Campo etiqueta="Responsable"><input name="responsable" maxLength={80} className="campo" /></Campo>
            </div>
            <BotonEnviar>Registrar y enviar a Gerencia</BotonEnviar>
            <p className="text-xs text-texto-2">Requiere la fecha de arranque fijada y la apertura abierta. Al aprobar Gerencia, el costo y la depreciación acumulada se contabilizan contra «Saldos de apertura».</p>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
