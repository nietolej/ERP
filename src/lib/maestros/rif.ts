/**
 * RIF venezolano: formato L-NNNNNNNN-D con dígito verificador del SENIAT (módulo 11).
 * Es el mismo algoritmo de fn_rif_valido (migración 0007); la base es la que decide.
 * Sin dependencias de servidor: se usa también en el formulario para avisar al escribir.
 */

const LETRAS = 'VEJPG';
const PESOS = [3, 2, 7, 6, 5, 4, 3, 2];

export function digitoVerificador(letra: string, numero: string): number {
  let suma = 4 * (LETRAS.indexOf(letra) + 1);
  for (let i = 0; i < 8; i++) suma += Number(numero[i]) * PESOS[i];
  const dv = 11 - (suma % 11);
  return dv >= 10 ? 0 : dv;
}

/**
 * Lleva lo que escribe el usuario al formato canónico, o null si no se puede interpretar.
 * Acepta 'j123456784', 'J-12345678-4', 'V-1234567-8' (rellena el número a 8 dígitos si viene con guiones).
 */
export function normalizarRif(entrada: string): string | null {
  const t = entrada.trim().toUpperCase().replace(/[\s.]/g, '');
  const conGuiones = /^([VEJPG])-?(\d{1,8})-(\d)$/.exec(t);
  if (conGuiones) return `${conGuiones[1]}-${conGuiones[2].padStart(8, '0')}-${conGuiones[3]}`;
  const corrido = /^([VEJPG])(\d{8})(\d)$/.exec(t.replace(/-/g, ''));
  if (corrido) return `${corrido[1]}-${corrido[2]}-${corrido[3]}`;
  return null;
}

export function rifValido(rif: string): boolean {
  const m = /^([VEJPG])-(\d{8})-(\d)$/.exec(rif);
  return !!m && digitoVerificador(m[1], m[2]) === Number(m[3]);
}

/** V, E y P son personas naturales; J y G, jurídicas. */
export function tipoPersona(rif: string): 'N' | 'J' {
  return 'JG'.includes(rif[0]) ? 'J' : 'N';
}

/** Mensaje para el usuario, o null si el RIF es válido. */
export function problemaDeRif(entrada: string): string | null {
  const rif = normalizarRif(entrada);
  if (!rif) return 'El RIF debe tener el formato J-12345678-4 (letra V, E, J, P o G, 8 dígitos y el dígito verificador).';
  if (!rifValido(rif)) return `El dígito verificador del RIF ${rif} no es correcto.`;
  return null;
}
