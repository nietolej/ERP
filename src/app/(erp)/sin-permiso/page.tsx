import Link from 'next/link';
import { Panel } from '@/components/ui';

export default function SinPermisoPage() {
  return (
    <Panel titulo="Sin permiso">
      <p className="text-sm text-texto-2">
        Su usuario no tiene el rol necesario para esta sección. Si lo necesita, pídale al administrador que se lo asigne.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm font-semibold text-acento">← Volver al inicio</Link>
    </Panel>
  );
}
