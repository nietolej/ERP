import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';
import {
  ESTADOS_PROMOCION, NOMBRE_TIPO_PROMOCION, ROLES_CREAN_PROMOCIONES, ROLES_VEN_PROMOCIONES, TEXTO_PROMOCION, TIPOS_PROMOCION, TONO_PROMOCION,
  buscarPromociones,
} from '@/lib/ventas/promociones';
import { crearPromocionAccion } from './acciones';

export default async function PromocionesPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PROMOCIONES);
  const { estado = '' } = await searchParams;
  const filtro = (ESTADOS_PROMOCION as readonly string[]).includes(estado) ? estado : '';
  const filas = await buscarPromociones(await getDb(), { estado: filtro });
  const puedeCrear = tieneRol(u, [...ROLES_CREAN_PROMOCIONES]);

  return (
    <>
      <Encabezado titulo="Promociones"
        descripcion="Descuentos o precios especiales por producto, código común, categoría, marca o cliente. Las aprueba Gerencia y los pedidos las aplican solos cuando dejan un precio menor que el del cliente." />
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {[{ valor: '', texto: 'Todas' }, ...ESTADOS_PROMOCION.map((e) => ({ valor: e, texto: TEXTO_PROMOCION[e] }))].map((f) => (
            <Link key={f.valor} href={f.valor ? `/ventas/promociones?estado=${f.valor}` : '/ventas/promociones'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Código', 'Nombre', 'Tipo', 'Vigencia', { t: 'Líneas', derecha: true }, { t: 'Unidades', derecha: true }, { t: 'Descuento otorgado', derecha: true }, 'Estado']}
          vacio="No hay promociones con ese filtro.">
          {filas.map((p) => (
            <tr key={p.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/ventas/promociones/${p.id}`} className="text-acento hover:underline">{p.codigo}</Link></Celda>
              <Celda>{p.nombre}</Celda>
              <Celda className="text-texto-2">{NOMBRE_TIPO_PROMOCION[p.tipo]}{p.descuento_pct ? ` · ${Number(p.descuento_pct)} %` : ''}</Celda>
              <Celda>{fecha(p.vigente_desde)} → {fecha(p.vigente_hasta)} {p.vigente_hoy && <Etiqueta tono="exito">rige hoy</Etiqueta>}</Celda>
              <Celda derecha mono>{p.lineas}</Celda>
              <Celda derecha mono>{Number(p.unidades)}</Celda>
              <Celda derecha>{monto(p.descuento_usd, 'US$ ')}</Celda>
              <Celda><Etiqueta tono={TONO_PROMOCION[p.estado]}>{TEXTO_PROMOCION[p.estado]}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {puedeCrear && (
        <Panel titulo="Nueva promoción" className="mt-5">
          <p className="mb-3 text-sm text-texto-2">Se crea en borrador: después indique a qué aplica y envíela a aprobación.</p>
          <Formulario accion={crearPromocionAccion} className="grid gap-3 md:grid-cols-3 md:items-end">
            <Campo etiqueta="Nombre"><input name="nombre" required maxLength={100} placeholder="Frenos de temporada" className="campo" /></Campo>
            <Campo etiqueta="Tipo">
              <select name="tipo" required defaultValue="descuento_pct" className="campo">
                {TIPOS_PROMOCION.map((t) => <option key={t} value={t}>{NOMBRE_TIPO_PROMOCION[t]}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Descuento (%)" ayuda="Solo para el descuento porcentual. En el precio especial, el precio va en cada producto.">
              <input name="descuento_pct" inputMode="decimal" className="campo text-right tabular-nums" />
            </Campo>
            <Campo etiqueta="Compra mínima por línea" ayuda="Vacío = sin mínimo"><input name="cantidad_minima" inputMode="decimal" className="campo text-right tabular-nums" /></Campo>
            <Campo etiqueta="Rige desde"><input type="date" name="vigente_desde" required className="campo" /></Campo>
            <Campo etiqueta="Rige hasta"><input type="date" name="vigente_hasta" required className="campo" /></Campo>
            <div className="md:col-span-2"><Campo etiqueta="Descripción (opcional)"><input name="descripcion" maxLength={250} className="campo" /></Campo></div>
            <div className="md:text-right"><BotonEnviar>Crear promoción</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
