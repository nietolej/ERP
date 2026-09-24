-- =====================================================================
-- 0005 · Límite de intentos de inicio de sesión (§4.3)
-- =====================================================================

-- Intentos fallidos recientes, por correo y por dirección IP.
-- `clave` es el SHA-256 de 'email:<correo>' o 'ip:<dirección>': la tabla no guarda
-- datos personales en claro (AGENTS.md §6), ni siquiera de correos que no existen.
create table intento_fallido (
  id         bigint generated always as identity primary key,
  clave      text not null,
  created_at timestamptz not null default now()
);
create index intento_fallido_clave_idx on intento_fallido (clave, created_at);
create index intento_fallido_fecha_idx on intento_fallido (created_at);
