import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_SESION } from '@/lib/auth/constantes';

/**
 * Chequeo rápido en todas las rutas (incluidas las API): sin cookie de sesión,
 * no se entra. La validación real contra la base la hace la DAL (src/lib/auth/dal.ts).
 */
const RUTAS_PUBLICAS = new Set(['/login']);

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (RUTAS_PUBLICAS.has(pathname) || req.cookies.has(COOKIE_SESION)) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
