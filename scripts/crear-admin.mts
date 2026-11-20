/**
 * Crea el primer usuario administrador (día 0). Genera una clave temporal que se
 * muestra UNA sola vez y que el usuario debe cambiar al entrar.
 *
 * Uso: npm run db:crear-admin -- --email admin@empresa.com --nombre "Nombre Apellido"
 */
import './entorno.mts';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { hayAdministradorActivo } from '../src/lib/auth/admin-inicial';
import { EMAIL_USUARIO_DEV } from '../src/lib/auth/constantes';
import { claveTemporal, hashClave } from '../src/lib/auth/clave';
import { getDb } from '../src/lib/db';

const { values } = parseArgs({
  options: { email: { type: 'string' }, nombre: { type: 'string' }, preparar: { type: 'boolean' } },
});
const db = await getDb();
if (await hayAdministradorActivo(db)) {
  if (values.preparar) process.exit(0);
  console.error('Ya existe un administrador activo. Los demás usuarios se crean desde Configuración → Usuarios y roles.');
  process.exit(1);
}

let email = values.email;
let nombre = values.nombre;
if (values.preparar) {
  const consola = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Se requiere un administrador para iniciar sesión.');
    email = await consola.question('Correo del administrador: ');
    nombre = await consola.question('Nombre y apellido: ');
  } finally {
    consola.close();
  }
}
email = email?.trim().toLowerCase();
nombre = nombre?.trim();
if (!email || !nombre || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === EMAIL_USUARIO_DEV) {
  console.error('Indique un correo válido de administrador y su nombre.');
  process.exit(1);
}

const clave = claveTemporal();
const creado = await db.transaction(async (tx) => {
  await tx.query('lock table usuario_rol in share row exclusive mode');
  if (await hayAdministradorActivo(tx)) return false;
  const { rows } = await tx.query<{ id: string }>(
    'insert into usuario (email, nombre, password_hash) values ($1, $2, $3) returning id',
    [email, nombre, await hashClave(clave)]);
  await tx.query(`insert into usuario_rol (usuario_id, rol) values ($1, 'administrador')`, [rows[0].id]);
  return true;
}).catch(() => {
  console.error('No se pudo crear el administrador. Verifique que el correo esté disponible y que la base responda.');
  process.exit(1);
});

if (creado) {
  console.log(`Clave temporal (se muestra una sola vez): ${clave}`);
  console.log('Anótela antes de continuar. Debe cambiarla en su primer ingreso.');
}
process.exit(0);
