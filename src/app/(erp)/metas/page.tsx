import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirSesion } from '@/lib/auth/dal';

export default async function MetasPage() {
  await exigirSesion();
  return (
    <>
      <Encabezado titulo="Configuración de Metas" descripcion="Metas de venta por cliente, vendedor, producto, grupo o global" />
      <Panel>
        <Aviso tono="info">
          Se habilita en la <strong>Fase 1</strong>, junto con los maestros de clientes, vendedores y productos a los que se asignan las metas
          (carga por Excel, captura manual, versiones y aprobación de Gerencia — spec_reportes §10).
        </Aviso>
      </Panel>
    </>
  );
}
