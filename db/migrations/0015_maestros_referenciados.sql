-- =====================================================================
-- 0015 · Un maestro con registros asociados no se borra (§13, Fase 1)
--
--   R-AA  Las metas y los adjuntos apuntan a clientes, proveedores, vendedores, productos y
--         grupos por identificador, sin llave foránea (el destino cambia según el tipo). Este
--         disparador cubre ese hueco: un maestro con metas o adjuntos, aunque sean anulados o
--         de lotes rechazados, no se borra; se inactiva. Cuando existan los documentos (Fase 2)
--         se extiende con ellos o con llaves foráneas.
-- =====================================================================

create function fn_maestro_referenciado() returns trigger
language plpgsql as $$
declare
  v_id uuid := (to_jsonb(old) ->> tg_argv[0])::uuid;
begin
  if exists (select 1 from meta_venta where entidad_id = v_id)
     or exists (select 1 from adjunto where entidad_id = v_id) then
    raise exception 'No se puede borrar: tiene metas o adjuntos registrados. Inactívelo';
  end if;
  return old;
end $$;

-- El argumento es la columna que identifica al registro en meta_venta y adjunto.
create trigger cliente_referenciado   before delete on cliente        for each row execute function fn_maestro_referenciado('tercero_id');
create trigger proveedor_referenciado before delete on proveedor      for each row execute function fn_maestro_referenciado('tercero_id');
create trigger vendedor_referenciado  before delete on vendedor       for each row execute function fn_maestro_referenciado('id');
create trigger producto_referenciado  before delete on producto       for each row execute function fn_maestro_referenciado('id');
create trigger grupo_referenciado     before delete on grupo_producto for each row execute function fn_maestro_referenciado('id');
