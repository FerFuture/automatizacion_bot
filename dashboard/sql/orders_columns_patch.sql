alter table public.orders
  add column if not exists address text,
  add column if not exists total_price numeric(12,2),
  add column if not exists payment_method text,
  add column if not exists payment_status text,
  add column if not exists status text default 'pending';
