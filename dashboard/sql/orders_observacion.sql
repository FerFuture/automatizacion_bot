-- Observación libre del mozo (ej. "sin mayonesa"). Opcional.
-- Idempotente: re-ejecutable en Supabase SQL Editor.

alter table public.orders
  add column if not exists observacion text;

comment on column public.orders.observacion is
  'Observación libre del pedido (mozo). Ej: sin mayonesa. Opcional.';
