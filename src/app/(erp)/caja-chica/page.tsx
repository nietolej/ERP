import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirSesion, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { ROLES_CUSTODIO, ROLES_VEN_CAJA } from '@/lib/gastos/roles';
import { cajasLibres, custodiosPosibles, listarFondos } from '@/lib/gastos/caja-chica';
import { crearFondoAccion } from './acciones';

export default async function CajaChicaPage() {
  const u = await exigirSesion();
  if (!tieneRol(u, [...ROLES_VEN_CAJA, ...ROLES_CUSTODIO])) {
    return <Aviso tono="peligro">No tiene permiso para ver la caja chica.</Aviso>;
  }
  const db = await getDb();
  const fondos = await listarFondos(db, u);
  const esGerencia = tieneRol(u, ['gerencia']);
  const [cajas, custodios] = esGerencia ? await Promise.all([cajasLibres(db), custodiosPosibles(db)]) : [[], []];

  return (
    <>
      <Encabezado titulo="Caja chica"
        descripcion="Fondo fijo por custodio y moneda. Cada vale gasta el fondo con su soporte; la reposición lo devuelve a su monto con la aprobación de Gerencia." />
      <Panel>
        <Tabla columnas={['Fondo', 'Custodio', { t: 'Monto fijo', derecha: true }, { t: 'Saldo', derecha: true }, { t: 'Por reponer', derecha: true }, 'Estado']}
          vacio="Todavía no hay fondos de caja chica.">
          {fondos.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda><Link href={`/caja-chica/${f.id}`} className="text-acento hover:underline"><span className="font-mono">{f.codigo}</span> · {f.nombre}</Link></Celda>
              <Celda>{f.custodio}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.monto_fijo)}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.saldo)}</Celda>
              <Celda derecha mono>{f.moneda} {monto(String(Number(f.por_reponer) + Number(f.en_reposicion)))}</Celda>
              <Celda>
                {!f.activo ? <Etiqueta tono="info">cerrado</Etiqueta> : f.constituido ? <Etiqueta tono="exito">en operación</Etiqueta> : <Etiqueta tono="advertencia">sin constituir</Etiqueta>}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {esGerencia && (
        <Panel titulo="Nuevo fondo" className="mt-5">
          {cajas.length === 0 ? (
            <Aviso tono="advertencia">Para crear un fondo necesita una cuenta de tipo caja sin fondo. Tesorería la crea en Cuentas bancarias y caja.</Aviso>
          ) : (
            <Formulario accion={crearFondoAccion} className="grid gap-4 sm:grid-cols-3">
              <Campo etiqueta="Nombre"><input name="nombre" required minLength={3} maxLength={80} className="campo" /></Campo>
              <Campo etiqueta="Custodio" ayuda="Tesorería, Contabilidad o Gerencia.">
                <select name="custodio_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {custodios.map((c) => <option key={c.id} value={c.id}>{c.texto}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Caja donde está el efectivo" ayuda="Fija la moneda del fondo.">
                <select name="cuenta_bancaria_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {cajas.map((c) => <option key={c.id} value={c.id}>{c.texto}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Monto fijo del fondo"><input name="monto_fijo" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
              <Campo etiqueta="Tope por vale" ayuda="Un vale mayor se registra como factura de gasto."><input name="tope_vale" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
              <div className="flex items-end"><BotonEnviar>Crear fondo</BotonEnviar></div>
            </Formulario>
          )}
        </Panel>
      )}
    </>
  );
}
