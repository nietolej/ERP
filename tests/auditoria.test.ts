import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consultarAuditoria, diferencias, entidadesAuditadas, limpiarFiltros, ROLES_VEN_AUDITORIA, rutaDeEntidad, TAMANO_PAGINA, valorLegible,
} from '@/lib/auditoria';
import { crearBanco } from '@/lib/maestros/bancos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('auditoría: funciones puras', () => {
  it('limpiarFiltros conserva solo valores con formato válido', () => {
    const u = '11111111-2222-3333-4444-555555555555';
    expect(limpiarFiltros({ desde: '2026-09-01', hasta: '2026-09-30', usuario: u, entidad: 'cliente', accion: 'UPDATE', registro: u, antes: '120' }))
      .toEqual({ desde: '2026-09-01', hasta: '2026-09-30', usuarioId: u, entidadId: u, entidad: 'cliente', accion: 'UPDATE', antes: 120 });
    expect(limpiarFiltros({
      desde: '01-09-2026', hasta: '2026-13-45', usuario: "1' or '1'='1", entidad: 'cliente; drop table x', accion: 'TRUNCATE', registro: 'a b', antes: '-5',
    })).toEqual({});
    expect(limpiarFiltros({})).toEqual({});
  });

  it('diferencias: en un UPDATE solo lo que cambió; en INSERT y DELETE lo que tiene valor', () => {
    expect(diferencias({ a: 1, b: 'x', c: null }, { a: 1, b: 'y', c: null })).toEqual([{ campo: 'b', antes: 'x', despues: 'y' }]);
    expect(diferencias({ a: { k: 1 } }, { a: { k: 2 } })).toEqual([{ campo: 'a', antes: { k: 1 }, despues: { k: 2 } }]);
    expect(diferencias(null, { z: 1, y: null, x: 'v' }).map((c) => c.campo)).toEqual(['x', 'z']);
    expect(diferencias({ z: 1, y: null }, null).map((c) => c.campo)).toEqual(['z']);
    expect(diferencias({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('valorLegible acorta valores enormes y marca los vacíos', () => {
    expect(valorLegible(null)).toBe('—');
    expect(valorLegible({ a: 1 })).toBe('{"a":1}');
    expect(valorLegible('x'.repeat(500))).toHaveLength(201);
  });

  it('rutaDeEntidad enlaza solo entidades con pantalla y con id válido', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(rutaDeEntidad('cliente', id)).toBe(`/maestros/clientes/${id}`);
    expect(rutaDeEntidad('meta_lote', id)).toBe(`/metas/lote/${id}`);
    expect(rutaDeEntidad('usuario', id)).toBeNull();
    expect(rutaDeEntidad('cliente', null)).toBeNull();
    expect(rutaDeEntidad('cliente', 'no-es-uuid')).toBeNull();
  });

  it('solo Administrador, Auditor y Gerencia ven la auditoría', () => {
    expect([...ROLES_VEN_AUDITORIA].sort()).toEqual(['administrador', 'auditor', 'gerencia']);
  });
});

describe('auditoría: consulta', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let tesorero: string;
  let otro: string;

  const como = (usuario: string, fn: (tx: Db) => Promise<unknown>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    tesorero = await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']);
    otro = await usuarioDePrueba(db, 'otro@prueba.test', ['gerencia']);
    for (let i = 0; i < 30; i++) await como(tesorero, (tx) => crearBanco(tx, `B${String(i).padStart(3, '0')}`, { nombre: `Banco ${i}`, pais: 'VE' }));
    await como(otro, (tx) => tx.query(`update banco set activo = false where codigo = 'B001'`));
  });
  afterAll(() => cerrar());

  it('devuelve los movimientos del más reciente al más antiguo, con quién los hizo', async () => {
    const { filas } = await consultarAuditoria(db, { entidad: 'banco' });
    expect(filas[0]).toMatchObject({ accion: 'UPDATE', entidad: 'banco', usuario: 'Usuario de prueba' });
    expect(filas[0].antes).toMatchObject({ activo: true });
    expect(filas[0].despues).toMatchObject({ activo: false });
    const ids = filas.map((f) => Number(f.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('filtra por usuario, acción y registro', async () => {
    const delOtro = await consultarAuditoria(db, { usuarioId: otro, entidad: 'banco' });
    expect(delOtro.filas).toHaveLength(1);
    const inserts = await consultarAuditoria(db, { entidad: 'banco', accion: 'INSERT' });
    expect(inserts.filas.every((f) => f.accion === 'INSERT')).toBe(true);
    const id = delOtro.filas[0].entidad_id as string;
    const historial = await consultarAuditoria(db, { entidadId: id });
    expect(historial.filas.map((f) => f.accion)).toEqual(['UPDATE', 'INSERT']);
  });

  it('filtra por fechas (hora de Caracas)', async () => {
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
    expect((await consultarAuditoria(db, { entidad: 'banco', desde: hoy, hasta: hoy })).filas.length).toBeGreaterThan(0);
    expect((await consultarAuditoria(db, { entidad: 'banco', hasta: '2000-01-01' })).filas).toHaveLength(0);
    expect((await consultarAuditoria(db, { entidad: 'banco', desde: '2999-01-01' })).filas).toHaveLength(0);
  });

  it('pagina de a 50 hacia atrás sin repetir ni saltar registros', async () => {
    const total = Number((await db.query<{ n: number }>('select count(*)::int as n from audit_log')).rows[0].n);
    expect(total).toBeGreaterThan(TAMANO_PAGINA);
    const vistos: string[] = [];
    let antes: number | undefined;
    for (let i = 0; i < 10; i++) {
      const p = await consultarAuditoria(db, { antes });
      vistos.push(...p.filas.map((f) => f.id));
      expect(p.filas.length).toBeLessThanOrEqual(TAMANO_PAGINA);
      if (!p.hayMas) break;
      antes = Number(p.filas[p.filas.length - 1].id);
    }
    expect(vistos).toHaveLength(total);
    expect(new Set(vistos).size).toBe(total);
  });

  it('lista las entidades con registros y nunca incluye secretos de las contraseñas', async () => {
    const entidades = await entidadesAuditadas(db);
    expect(entidades).toEqual(expect.arrayContaining(['banco', 'usuario', 'usuario_rol']));
    expect(entidades).toEqual([...entidades].sort());
    const { filas } = await consultarAuditoria(db, { entidad: 'usuario', accion: 'INSERT' });
    for (const f of filas) expect(f.despues).not.toHaveProperty('password_hash');
  });
});
