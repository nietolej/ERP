import Link from 'next/link';
import { Formulario } from '@/components/formulario';
import { Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { COLUMNAS_PLANTILLA, MAX_FILAS_CARGA, ROLES_CARGAN_PRODUCTOS } from '@/lib/maestros/carga-productos';
import { cargarProductosAccion } from './acciones';

export default async function CargaProductosPage() {
  await exigirRol(...ROLES_CARGAN_PRODUCTOS);
  return (
    <>
      <Encabezado titulo="Carga masiva de productos"
        descripcion="Para crear el catálogo de una vez con la plantilla del ERP. El sistema valida fila por fila: con un solo error se rechaza la carga completa y no se crea nada. La alternativa recomendada es crear los productos a medida que se cuentan en el conteo inicial.">
        <Link href="/maestros/productos" className="text-sm text-texto-2 hover:text-texto">← Productos</Link>
      </Encabezado>
      <Panel titulo="1. Plantilla">
        <p className="text-sm text-texto-2">
          <a href="/api/maestros/productos/plantilla" className="font-semibold text-acento hover:underline">Descargar la plantilla (CSV)</a>. Ábrala en Excel y guárdela como CSV (delimitado por punto y coma o coma, UTF-8).
          Máximo {MAX_FILAS_CARGA} filas por carga.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-texto-2">
          <li><span className="font-mono">codigo</span>, <span className="font-mono">descripcion</span>, <span className="font-mono">codigo_comun</span>, <span className="font-mono">marca</span>, <span className="font-mono">unidad</span> y <span className="font-mono">alicuota</span> son obligatorios.</li>
          <li><span className="font-mono">marca</span>, <span className="font-mono">grupo</span> y <span className="font-mono">alicuota</span> se escriben con su <strong>código</strong> y deben existir (GENERAL, REDUCIDA, EXENTO…). Las marcas y grupos se crean en Productos → Catálogos.</li>
          <li>El código común se crea solo si no existe, con la descripción del producto. Un código común admite una marca una sola vez.</li>
          <li><span className="font-mono">inventariable</span>: SI o NO (vacío = SI). <span className="font-mono">linea_calidad</span>: original, oem o alterna. <span className="font-mono">pais_origen</span>: dos letras.</li>
          <li>Las columnas <span className="font-mono">precio_a</span>, <span className="font-mono">precio_b</span> y <span className="font-mono">precio_d</span> (US$) solo las puede llenar Gerencia o Supervisor de ventas; rigen desde hoy.</li>
        </ul>
        <p className="mt-3 text-xs text-texto-2">Columnas: {COLUMNAS_PLANTILLA.join(', ')}.</p>
      </Panel>
      <Panel titulo="2. Validar y cargar" className="mt-5">
        <Formulario accion={cargarProductosAccion} className="space-y-4">
          <Campo etiqueta="Archivo CSV"><input type="file" name="archivo" accept=".csv,.txt" required className="campo" /></Campo>
          <div className="flex flex-wrap gap-3">
            <button type="submit" name="modo" value="validar" className="rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">Solo validar</button>
            <button type="submit" name="modo" value="cargar" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Validar y cargar</button>
          </div>
        </Formulario>
        <p className="mt-3 text-xs text-texto-2">«Solo validar» revisa todo y no guarda nada. «Validar y cargar» crea los productos solo si todas las filas están bien.</p>
      </Panel>
    </>
  );
}
