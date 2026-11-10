'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { abrirCaso, actualizarCaso, cambiarEstadoCaso, enlazarNotaCredito, type EstadoCaso, type TipoCaso } from '@/lib/crm/casos';
import { ROLES_CASOS, ROLES_CRM, UUID } from '@/lib/crm/comun';
import { actualizarContacto, crearContacto, registrarActividad, type TipoActividad } from '@/lib/crm/contactos';
import {
  agregarLineaCotizacion, anularCotizacion, crearCotizacion, eliminarCotizacion, emitirCotizacion, quitarLineaCotizacion,
} from '@/lib/crm/cotizaciones';
import {
  actualizarOportunidad, avanzarOportunidad, cambiarCotizacion, crearOportunidad, ganarOportunidad, generarPedidoDeOportunidad, perderOportunidad,
} from '@/lib/crm/oportunidades';
import { descartarProspecto, reactivarProspecto, reasignarProspecto, registrarProspecto } from '@/lib/crm/prospectos';
import { ErrorConfirmable, ErrorMaestro } from '@/lib/errores';
import { productoPorCodigo } from '@/lib/ventas/pedidos';

/** Acciones del módulo CR (§6.5). La seguridad por fila la aplica cada función de src/lib/crm. */

function recargar(...rutas: string[]) {
  revalidatePath('/crm');
  for (const r of rutas) revalidatePath(r);
}

const ficha = (id: string) => `/crm/terceros/${id}`;

// ---------------------------------------------------------------------
// Prospectos y contactos
// ---------------------------------------------------------------------

export async function registrarProspectoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_CRM);
    id = await conUsuario(u.id, (tx) => registrarProspecto(tx, u, {
      rif: texto(fd, 'rif'),
      tercero: {
        razonSocial: texto(fd, 'razon_social'), nombreComercial: texto(fd, 'nombre_comercial'), telefono: texto(fd, 'telefono'),
        email: texto(fd, 'email'), direccionFiscal: texto(fd, 'direccion_fiscal'),
        domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false,
      },
      vendedorId: texto(fd, 'vendedor_id') || null, origen: texto(fd, 'origen'),
      confirmarNombreParecido: fd.get('confirmar') === 'on',
    }));
  } catch (e) {
    return { error: mensajeDeError(e), confirmar: e instanceof ErrorConfirmable };
  }
  recargar('/crm/prospectos');
  redirect(ficha(id));
}

export async function estadoProspectoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CRM);
    const id = texto(fd, 'id');
    const accion = texto(fd, 'accion');
    await conUsuario(u.id, (tx) => {
      if (accion === 'descartar') return descartarProspecto(tx, u, id, texto(fd, 'motivo'));
      if (accion === 'reactivar') return reactivarProspecto(tx, u, id);
      return reasignarProspecto(tx, u, id, texto(fd, 'vendedor_id'));
    });
    recargar('/crm/prospectos', ficha(id));
    return { ok: accion === 'descartar' ? 'Prospecto descartado.' : accion === 'reactivar' ? 'Prospecto reactivado.' : 'Prospecto reasignado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function guardarContactoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CRM);
    const terceroId = texto(fd, 'tercero_id');
    const id = texto(fd, 'id');
    const d = {
      nombre: texto(fd, 'nombre'), cargo: texto(fd, 'cargo'), telefono: texto(fd, 'telefono'), correo: texto(fd, 'correo'),
      principal: fd.get('principal') === 'on',
    };
    await conUsuario(u.id, (tx) => id
      ? actualizarContacto(tx, u, id, { ...d, activo: fd.get('activo') === 'on' })
      : crearContacto(tx, u, terceroId, d).then(() => undefined));
    recargar(ficha(terceroId));
    return { ok: id ? 'Contacto actualizado.' : 'Contacto agregado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function registrarActividadAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CRM);
    const terceroId = texto(fd, 'tercero_id');
    if (!UUID.test(terceroId)) return { error: 'Seleccione el cliente o prospecto.' };
    const oportunidadId = texto(fd, 'oportunidad_id');
    await conUsuario(u.id, (tx) => registrarActividad(tx, u, {
      terceroId, oportunidadId: oportunidadId || null, tipo: texto(fd, 'tipo') as TipoActividad, fecha: texto(fd, 'fecha') || undefined,
      resultado: texto(fd, 'resultado'), proximaAccion: texto(fd, 'proxima_accion'), proximaFecha: texto(fd, 'proxima_fecha') || undefined,
    }));
    recargar('/crm/actividades', ficha(terceroId));
    if (oportunidadId) revalidatePath(`/crm/oportunidades/${oportunidadId}`);
    return { ok: 'Actividad registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------
// Cotizaciones
// ---------------------------------------------------------------------

export async function crearCotizacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_CRM);
    const terceroId = texto(fd, 'tercero_id');
    const almacenId = texto(fd, 'almacen_id');
    if (!UUID.test(terceroId)) return { error: 'Seleccione el cliente o prospecto.' };
    if (!UUID.test(almacenId)) return { error: 'Seleccione el almacén.' };
    id = await conUsuario(u.id, (tx) => crearCotizacion(tx, u, {
      terceroId, almacenId, listaPrecio: texto(fd, 'lista_precio') || undefined, vendedorId: texto(fd, 'vendedor_id') || null,
      observaciones: texto(fd, 'observaciones'),
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar('/crm/cotizaciones');
  redirect(`/crm/cotizaciones/${id}`);
}

export async function lineaCotizacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CRM);
    const id = texto(fd, 'id');
    const lineaId = texto(fd, 'linea_id');
    await conUsuario(u.id, async (tx) => {
      if (lineaId) return quitarLineaCotizacion(tx, u, id, lineaId);
      const productoId = await productoPorCodigo(tx, texto(fd, 'codigo'));
      return agregarLineaCotizacion(tx, u, id, {
        productoId, cantidad: texto(fd, 'cantidad'), descuentoPct: texto(fd, 'descuento') || undefined, motivoDescuentoId: texto(fd, 'motivo_id') || undefined,
      });
    });
    recargar(`/crm/cotizaciones/${id}`);
    return { ok: lineaId ? 'Línea quitada.' : 'Producto agregado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function estadoCotizacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  const id = texto(fd, 'id');
  const accion = texto(fd, 'accion');
  try {
    const u = await autorizar(...ROLES_CRM);
    if (accion === 'eliminar') {
      await conUsuario(u.id, (tx) => eliminarCotizacion(tx, u, id));
    } else if (accion === 'emitir') {
      const numero = await conUsuario(u.id, (tx) => emitirCotizacion(tx, u, id, texto(fd, 'vigente_hasta')));
      recargar('/crm/cotizaciones', `/crm/cotizaciones/${id}`);
      return { ok: `Cotización ${numero} emitida.` };
    } else {
      await conUsuario(u.id, (tx) => anularCotizacion(tx, u, id, texto(fd, 'motivo')));
      recargar('/crm/cotizaciones', `/crm/cotizaciones/${id}`);
      return { ok: 'Cotización anulada.' };
    }
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar('/crm/cotizaciones');
  redirect('/crm/cotizaciones');
}

// ---------------------------------------------------------------------
// Oportunidades
// ---------------------------------------------------------------------

const datosOportunidad = (fd: FormData) => ({
  titulo: texto(fd, 'titulo'), montoEstimadoUsd: texto(fd, 'monto'), cierreEstimado: texto(fd, 'cierre') || undefined,
  vendedorId: texto(fd, 'vendedor_id') || null,
});

export async function crearOportunidadAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_CRM);
    const terceroId = texto(fd, 'tercero_id');
    if (!UUID.test(terceroId)) return { error: 'Seleccione el cliente o prospecto.' };
    id = await conUsuario(u.id, (tx) => crearOportunidad(tx, u, terceroId, datosOportunidad(fd)));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar('/crm/oportunidades');
  redirect(`/crm/oportunidades/${id}`);
}

export async function oportunidadAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CRM);
    const id = texto(fd, 'id');
    const accion = texto(fd, 'accion');
    let ok = '';
    let pedidoId: string | null = null;
    await conUsuario(u.id, async (tx) => {
      switch (accion) {
        case 'guardar':
          await actualizarOportunidad(tx, u, id, datosOportunidad(fd));
          ok = 'Oportunidad actualizada.';
          break;
        case 'avanzar': {
          const etapa = await avanzarOportunidad(tx, u, id, { cotizacionId: texto(fd, 'cotizacion_id') || undefined });
          ok = `La oportunidad pasó a ${etapa === 'negociacion' ? 'Negociación' : etapa === 'calificada' ? 'Calificada' : 'Cotizada'}.`;
          break;
        }
        case 'cotizacion':
          await cambiarCotizacion(tx, u, id, texto(fd, 'cotizacion_id'));
          ok = 'Cotización enlazada.';
          break;
        case 'perder':
          await perderOportunidad(tx, u, id, texto(fd, 'motivo_id'), texto(fd, 'detalle'));
          ok = 'Oportunidad cerrada como perdida.';
          break;
        case 'ganar': {
          const r = await ganarOportunidad(tx, u, id);
          pedidoId = r.pedidoId;
          ok = r.clientePendiente
            ? 'Oportunidad ganada. El prospecto quedó registrado como cliente pendiente: el pedido se genera cuando Gerencia lo apruebe.'
            : `Oportunidad ganada: se generó el pedido en borrador.${r.difiereDeCotizacion ? ' Revíselo: no suma lo mismo que la cotización (precio o descuento vigente del cliente).' : ''}`;
          break;
        }
        case 'pedido': {
          const r = await generarPedidoDeOportunidad(tx, u, id);
          pedidoId = r.pedidoId;
          ok = `Se generó el pedido en borrador.${r.difiereDeCotizacion ? ' Revíselo: no suma lo mismo que la cotización (precio o descuento vigente del cliente).' : ''}`;
          break;
        }
        default:
          throw new Error('Acción desconocida');
      }
    });
    recargar('/crm/oportunidades', `/crm/oportunidades/${id}`, '/crm/cotizaciones');
    if (pedidoId) revalidatePath('/ventas/pedidos');
    return { ok };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------
// Casos de postventa
// ---------------------------------------------------------------------

export async function abrirCasoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_CASOS);
    const clienteId = texto(fd, 'cliente_id');
    if (!UUID.test(clienteId)) return { error: 'Seleccione el cliente.' };
    const numeroFactura = texto(fd, 'factura');
    id = await conUsuario(u.id, async (tx) => {
      let facturaId: string | null = null;
      if (numeroFactura) {
        const { rows } = await tx.query<{ id: string }>(
          `select id from documento_venta where tipo = 'factura' and estado = 'emitido' and cliente_id = $1 and numero::text = $2`,
          [clienteId, numeroFactura.replace(/^[A-Z]+-/i, '')]);
        if (!rows[0]) throw new ErrorMaestro('No hay una factura emitida con ese número para el cliente.');
        facturaId = rows[0].id;
      }
      return (await abrirCaso(tx, u, { clienteId, tipo: texto(fd, 'tipo') as TipoCaso, facturaId, descripcion: texto(fd, 'descripcion') })).id;
    });
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar('/crm/casos');
  redirect(`/crm/casos/${id}`);
}

export async function casoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CASOS);
    const id = texto(fd, 'id');
    const accion = texto(fd, 'accion');
    await conUsuario(u.id, async (tx) => {
      if (accion === 'guardar') return actualizarCaso(tx, u, id, { responsableId: texto(fd, 'responsable_id') || null, causa: texto(fd, 'causa'), solucion: texto(fd, 'solucion') });
      if (accion === 'nota') return enlazarNotaCredito(tx, u, id, texto(fd, 'nota_id'));
      return cambiarEstadoCaso(tx, u, id, accion as EstadoCaso, fd.has('solucion') ? texto(fd, 'solucion') : undefined);
    });
    recargar('/crm/casos', `/crm/casos/${id}`);
    return { ok: accion === 'guardar' ? 'Caso actualizado.' : accion === 'nota' ? 'Nota de crédito enlazada.' : 'Estado del caso actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
