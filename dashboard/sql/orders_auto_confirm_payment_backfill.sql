-- Marca como pagados los pedidos históricos que aún no tienen pago confirmado,
-- para que entren en ventas/KPIs del panel de estadísticas.
-- Ejecutar una vez en Supabase → SQL Editor (proyecto restoillimani).

update public.orders
set
  payment_status = 'paid',
  payment_paid_at = coalesce(payment_paid_at, created_at, now())
where
  lower(coalesce(status::text, '')) not in ('cancelled')
  and lower(coalesce(payment_status::text, '')) not in ('paid', 'approved', 'cancelled');
