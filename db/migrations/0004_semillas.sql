-- =====================================================================
-- 0004 · Datos de configuración inicial (no son datos de operación)
-- =====================================================================

insert into rol (codigo, nombre, descripcion) values
  ('administrador',     'Administrador',        'Configuración del sistema, usuarios y seguridad'),
  ('gerencia',          'Gerencia',             'Aprobaciones y reportes gerenciales'),
  ('ventas',            'Ventas',               'Vendedor: pedidos y su propia cartera'),
  ('supervisor_ventas', 'Supervisor de ventas', 'Aprobación de descuentos y notas de crédito comerciales'),
  ('facturacion',       'Facturación',          'Emisión de documentos fiscales'),
  ('cobranzas',         'Cobranzas',            'Registro y aplicación de cobros'),
  ('compras',           'Compras',              'Órdenes de compra y proveedores'),
  ('almacen',           'Almacén',              'Recepciones, despachos, transferencias y conteos'),
  ('tesoreria',         'Tesorería',            'Pagos, bancos y conciliaciones'),
  ('contabilidad',      'Contabilidad',         'Asientos manuales, periodos y cierres'),
  ('auditor',           'Auditor',              'Solo lectura');

insert into moneda (codigo, nombre, simbolo) values
  ('VES',  'Bolívar',                 'Bs.'),
  ('USD',  'Dólar estadounidense',    'US$'),
  ('EUR',  'Euro',                    '€'),
  ('USDT', 'Tether (activo digital)', 'USDT');

insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('asiento', 'A', '', 1);

-- ---------------------------------------------------------------------
-- Parámetros fiscales de REFERENCIA (§11.2). Quedan con validado_por_contador = false:
-- la pantalla los muestra como pendientes hasta que el contador los confirme.
-- ---------------------------------------------------------------------
insert into parametro_fiscal (codigo, descripcion, valor, unidad, vigente_desde, fuente_normativa) values
  ('IVA_GENERAL',        'IVA: alícuota general',                             16, 'porcentaje', '2026-01-01', 'Ley de IVA'),
  ('IVA_REDUCIDA',       'IVA: alícuota reducida',                             8, 'porcentaje', '2026-01-01', 'Ley de IVA'),
  ('IVA_LUJO_ADICIONAL', 'IVA: alícuota adicional para bienes suntuarios',    15, 'porcentaje', '2026-01-01', 'Ley de IVA'),
  ('RET_IVA_GENERAL',    'Retención de IVA: porcentaje general',              75, 'porcentaje', '2026-01-01', 'Providencia SNAT/2025/000054'),
  ('RET_IVA_TOTAL',      'Retención de IVA: supuestos del 100 %',            100, 'porcentaje', '2026-01-01', 'Providencia SNAT/2025/000054'),
  ('IGTF',               'IGTF sobre pagos en divisas o criptoactivos',        3, 'porcentaje', '2026-01-01', 'Ley de IGTF (tasa sujeta a decreto)'),
  ('UNIDAD_TRIBUTARIA',  'Valor de la Unidad Tributaria',                     43, 'bolivares',  '2025-06-02', 'G.O. 43.140 del 02-06-2025');

-- ---------------------------------------------------------------------
-- Plan de cuentas base (§12.1). Estructura inicial a revisar con el contador.
-- Los bancos se agregan como subcuentas al crear cada cuenta bancaria (Fase 1/3).
-- ---------------------------------------------------------------------
create temporary table _pc (codigo text, nombre text, tipo text, naturaleza char(1), imputable boolean, controlada_por text) on commit drop;

insert into _pc values
  ('1',          'ACTIVO',                                         'activo',     'D', false, null),
  ('1.1',        'Activo corriente',                               'activo',     'D', false, null),
  ('1.1.01',     'Caja',                                           'activo',     'D', false, null),
  ('1.1.01.01',  'Caja en bolívares',                              'activo',     'D', true,  null),
  ('1.1.01.02',  'Caja en dólares',                                'activo',     'D', true,  null),
  ('1.1.02',     'Bancos nacionales en bolívares',                 'activo',     'D', false, null),
  ('1.1.03',     'Bancos en divisas y custodia',                   'activo',     'D', false, null),
  ('1.1.04',     'Activos digitales',                              'activo',     'D', false, null),
  ('1.1.04.01',  'USDT',                                           'activo',     'D', true,  null),
  ('1.2',        'Cuentas por cobrar y créditos fiscales',         'activo',     'D', false, null),
  ('1.2.01',     'Cuentas por cobrar comerciales',                 'activo',     'D', true,  'cxc'),
  ('1.2.02',     'Anticipos a proveedores',                        'activo',     'D', true,  null),
  ('1.2.03',     'IVA crédito fiscal',                             'activo',     'D', true,  null),
  ('1.2.04',     'IVA retenido por clientes',                      'activo',     'D', true,  null),
  ('1.2.05',     'ISLR retenido por clientes y anticipos de ISLR', 'activo',     'D', true,  null),
  ('1.3',        'Inventarios',                                    'activo',     'D', false, null),
  ('1.3.01',     'Inventario de mercancía',                        'activo',     'D', true,  'inventario'),
  ('1.3.02',     'Mercancía en tránsito (importaciones)',          'activo',     'D', true,  null),
  ('1.4',        'Propiedad, planta y equipo',                     'activo',     'D', false, null),
  ('1.4.01',     'Mobiliario y equipos',                           'activo',     'D', true,  null),
  ('1.4.02',     'Depreciación acumulada',                         'activo',     'A', true,  null),
  ('2',          'PASIVO',                                         'pasivo',     'A', false, null),
  ('2.1',        'Pasivo corriente',                               'pasivo',     'A', false, null),
  ('2.1.01',     'Cuentas por pagar a proveedores',                'pasivo',     'A', true,  'cxp'),
  ('2.1.02',     'Mercancía recibida no facturada',                'pasivo',     'A', true,  null),
  ('2.1.03',     'IVA débito fiscal',                              'pasivo',     'A', true,  null),
  ('2.1.04',     'Retenciones de IVA por enterar',                 'pasivo',     'A', true,  null),
  ('2.1.05',     'Retenciones de ISLR por enterar',                'pasivo',     'A', true,  null),
  ('2.1.06',     'IGTF percibido por enterar',                     'pasivo',     'A', true,  null),
  ('2.1.07',     'Comisiones por pagar',                           'pasivo',     'A', true,  'comisiones'),
  ('2.1.08',     'Anticipos de clientes',                          'pasivo',     'A', true,  null),
  ('2.1.09',     'ISLR por pagar',                                 'pasivo',     'A', true,  null),
  ('3',          'PATRIMONIO',                                     'patrimonio', 'A', false, null),
  ('3.1.01',     'Capital social',                                 'patrimonio', 'A', true,  null),
  ('3.2.01',     'Reservas',                                       'patrimonio', 'A', true,  null),
  ('3.3.01',     'Utilidades acumuladas',                          'patrimonio', 'A', true,  null),
  ('3.3.02',     'Resultado del ejercicio',                        'patrimonio', 'A', true,  null),
  ('3.9.01',     'Saldos de apertura',                             'patrimonio', 'A', true,  'apertura'),
  ('4',          'INGRESOS',                                       'ingreso',    'A', false, null),
  ('4.1',        'Ingresos por ventas',                            'ingreso',    'A', false, null),
  ('4.1.01',     'Ventas de mercancía',                            'ingreso',    'A', true,  null),
  ('4.1.02',     'Devoluciones en ventas',                         'ingreso',    'D', true,  null),
  ('4.1.03',     'Descuentos en ventas',                           'ingreso',    'D', true,  null),
  ('4.2',        'Otros ingresos',                                 'ingreso',    'A', false, null),
  ('4.2.01',     'Ganancia por diferencial cambiario',             'ingreso',    'A', true,  null),
  ('4.2.02',     'Otros ingresos',                                 'ingreso',    'A', true,  null),
  ('5',          'COSTOS',                                         'costo',      'D', false, null),
  ('5.1.01',     'Costo de ventas',                                'costo',      'D', true,  null),
  ('5.1.02',     'Faltantes y sobrantes de inventario',            'costo',      'D', true,  null),
  ('6',          'GASTOS',                                         'gasto',      'D', false, null),
  ('6.1',        'Gastos de venta',                                'gasto',      'D', false, null),
  ('6.1.01',     'Comisiones de venta',                            'gasto',      'D', true,  null),
  ('6.1.02',     'Fletes de despacho',                             'gasto',      'D', true,  null),
  ('6.1.03',     'Publicidad',                                     'gasto',      'D', true,  null),
  ('6.2',        'Gastos de administración',                       'gasto',      'D', false, null),
  ('6.2.01',     'Sueldos y salarios',                             'gasto',      'D', true,  null),
  ('6.2.02',     'Alquileres',                                     'gasto',      'D', true,  null),
  ('6.2.03',     'Servicios',                                      'gasto',      'D', true,  null),
  ('6.3',        'Gastos financieros',                             'gasto',      'D', false, null),
  ('6.3.01',     'IGTF y comisiones bancarias',                    'gasto',      'D', true,  null),
  ('6.3.02',     'Pérdida por diferencial cambiario',              'gasto',      'D', true,  null),
  ('6.3.03',     'Diferencias por redondeo',                       'gasto',      'D', true,  null),
  ('6.4',        'Impuesto sobre la renta',                        'gasto',      'D', false, null),
  ('6.4.01',     'ISLR del ejercicio',                             'gasto',      'D', true,  null);

-- Se insertan por niveles para poder resolver el padre.
insert into cuenta_contable (codigo, nombre, tipo, naturaleza, imputable, controlada_por, padre_id)
select p.codigo, p.nombre, p.tipo, p.naturaleza, p.imputable, p.controlada_por, null
  from _pc p where p.codigo not like '%.%';

do $$
declare nivel int;
begin
  for nivel in 2..4 loop
    insert into cuenta_contable (codigo, nombre, tipo, naturaleza, imputable, controlada_por, padre_id)
    select p.codigo, p.nombre, p.tipo, p.naturaleza, p.imputable, p.controlada_por,
           (select c.id from cuenta_contable c
             where c.codigo = (select max(q.codigo) from _pc q
                                where p.codigo like q.codigo || '.%' and q.codigo <> p.codigo
                                  and not q.imputable))
      from _pc p
     where array_length(string_to_array(p.codigo, '.'), 1) = nivel;
  end loop;
end $$;

insert into configuracion_contable (clave, cuenta_id)
select v.clave, c.id
  from (values ('redondeo', '6.3.03'), ('diferencial_ganancia', '4.2.01'), ('diferencial_perdida', '6.3.02'),
               ('saldos_apertura', '3.9.01'), ('resultado_ejercicio', '3.3.02')) as v(clave, codigo)
  join cuenta_contable c on c.codigo = v.codigo;
