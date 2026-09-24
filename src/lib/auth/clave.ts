import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (clave: string, sal: Buffer, largo: number, opciones: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(clave, sal, largo, opciones, (err, derivada) => (err ? reject(err) : resolve(derivada))),
  );

// Parámetros de scrypt (recomendación OWASP: N=2^17, r=8, p=1).
const N = 131072;
const R = 8;
const P = 1;
const LARGO = 64;
const MAXMEM = 256 * 1024 * 1024;

/** Formato: scrypt$N$r$p$sal(base64)$hash(base64) */
export async function hashClave(clave: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scrypt(clave.normalize('NFKC'), sal, LARGO, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, sal.toString('base64'), hash.toString('base64')].join('$');
}

export async function verificarClave(clave: string, guardado: string): Promise<boolean> {
  const partes = guardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, n, r, p, salB64, hashB64] = partes;
  const esperado = Buffer.from(hashB64, 'base64');
  const obtenido = await scrypt(clave.normalize('NFKC'), Buffer.from(salB64, 'base64'), esperado.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return obtenido.length === esperado.length && timingSafeEqual(obtenido, esperado);
}

/** Devuelve la lista de requisitos que la clave no cumple (vacía si es válida). */
export function problemasDeClave(clave: string): string[] {
  const problemas: string[] = [];
  if (clave.length < 10) problemas.push('Debe tener al menos 10 caracteres.');
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(clave)) problemas.push('Debe incluir al menos una letra.');
  if (!/[0-9]/.test(clave)) problemas.push('Debe incluir al menos un número.');
  return problemas;
}

/** Clave temporal legible para entregar a un usuario nuevo (debe cambiarla al entrar). */
export function claveTemporal(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  // Se repite hasta que cumpla la regla de claves: sin esto, ~1 de cada 9 claves salía sin números.
  for (;;) {
    const bytes = randomBytes(14);
    let c = '';
    for (const b of bytes) c += alfabeto[b % alfabeto.length];
    const clave = `${c.slice(0, 7)}-${c.slice(7)}`;
    if (problemasDeClave(clave).length === 0) return clave;
  }
}
