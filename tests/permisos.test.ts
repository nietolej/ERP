import { describe, expect, it } from 'vitest';
import { tieneRol } from '@/lib/auth/permisos';

describe('permisos por rol', () => {
  it('permite si el usuario tiene alguno de los roles pedidos', () => {
    expect(tieneRol({ roles: ['tesoreria'] }, ['tesoreria', 'contabilidad'])).toBe(true);
    expect(tieneRol({ roles: ['auditor', 'contabilidad'] }, ['contabilidad'])).toBe(true);
  });

  it('niega si no tiene ninguno, o si no tiene roles', () => {
    expect(tieneRol({ roles: ['ventas'] }, ['contabilidad'])).toBe(false);
    expect(tieneRol({ roles: [] }, ['administrador'])).toBe(false);
  });

  it('el administrador no es superusuario: sin el rol de contabilidad no opera contabilidad', () => {
    expect(tieneRol({ roles: ['administrador'] }, ['contabilidad'])).toBe(false);
    expect(tieneRol({ roles: ['administrador'] }, ['tesoreria', 'contabilidad'])).toBe(false);
  });
});
