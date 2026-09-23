/**
 * Crea el primer usuario administrador (día 0). Genera una clave temporal que se
 * muestra UNA sola vez y que el usuario debe cambiar al entrar.
 *
 * Uso: npm run db:crear-admin -- --email admin@empresa.com --nombre "Nombre Apellido"
 */
import { parseArgs } from 'node:util';
import { claveTemporal, hashClave } from '../src/lib/auth/clave';
import { getDb } from '../src/lib/db';

const { values } = parseArgs({ options: { email: { type: 'string' }, nombre: { type: 'string' } } });
const email = values.email?.trim().toLowerCase();
const nombre = values.nombre?.trim();
if (!email || !nombre) {
  console.error('Uso: npm run db:crear-admin -- --email correo@empresa.com --nombre "Nombre Apellido"');
  process.exit(1);
}

const db = await getDb();
const { rows } = await db.query<{ n: string }>(
  `select count(*) as n from usuario u join usuario_rol r on r.usuario_id = u.id where r.rol = 'administrador' and u.activo`);
if (Number(rows[0].n) > 0) {
  console.error('Ya existe un administrador activo. Los demás usuarios se crean desde Configuración → Usuarios y roles.');
  process.exit(1);
}

const clave = claveTemporal();
await db.transaction(async (tx) => {
  const { rows: u } = await tx.query<{ id: string }>(
    'insert into usuario (email, nombre, password_hash) values ($1, $2, $3) returning id',
    [email, nombre, await hashClave(clave)]);
  await tx.query(`insert into usuario_rol (usuario_id, rol) values ($1, 'administrador')`, [u[0].id]);
});

console.log(`Administrador creado: ${email}`);
console.log(`Clave temporal (se muestra una sola vez): ${clave}`);
console.log('Debe cambiarla en su primer ingreso.');
process.exit(0);
