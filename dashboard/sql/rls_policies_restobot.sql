-- Políticas RLS para RestoBot cuando el dashboard usa la clave "anon".
-- Ejecutá esto en Supabase → SQL Editor (una vez). Ajustá nombres de esquema/tabla si usás otros.
--
-- El bot Node debería usar SUPABASE_SERVICE_ROLE_KEY (no pasa por RLS).
-- El dashboard Vite sigue con SUPABASE_KEY anon: necesita políticas explícitas si RLS está ON.
--
-- Seguridad: USING (true) permite a cualquiera con la clave anon leer/escribir esas tablas.
-- Para producción pública endurecé (auth, por restaurant_id, etc.).

-- ---------- restaurants ----------
alter table public.restaurants enable row level security;

drop policy if exists "restobot_restaurants_anon_select" on public.restaurants;
create policy "restobot_restaurants_anon_select"
  on public.restaurants for select to anon using (true);

drop policy if exists "restobot_restaurants_auth_select" on public.restaurants;
create policy "restobot_restaurants_auth_select"
  on public.restaurants for select to authenticated using (true);

-- ---------- menu_items ----------
alter table public.menu_items enable row level security;

drop policy if exists "restobot_menu_items_anon_all" on public.menu_items;
create policy "restobot_menu_items_anon_all"
  on public.menu_items for all to anon using (true) with check (true);

drop policy if exists "restobot_menu_items_auth_all" on public.menu_items;
create policy "restobot_menu_items_auth_all"
  on public.menu_items for all to authenticated using (true) with check (true);

-- ---------- bot_interactions (nombre por defecto del proyecto) ----------
alter table public.bot_interactions enable row level security;

drop policy if exists "restobot_interactions_anon_select" on public.bot_interactions;
create policy "restobot_interactions_anon_select"
  on public.bot_interactions for select to anon using (true);

drop policy if exists "restobot_interactions_anon_insert" on public.bot_interactions;
create policy "restobot_interactions_anon_insert"
  on public.bot_interactions for insert to anon with check (true);

drop policy if exists "restobot_interactions_auth_select" on public.bot_interactions;
create policy "restobot_interactions_auth_select"
  on public.bot_interactions for select to authenticated using (true);

drop policy if exists "restobot_interactions_auth_insert" on public.bot_interactions;
create policy "restobot_interactions_auth_insert"
  on public.bot_interactions for insert to authenticated with check (true);

-- ---------- orders ----------
alter table public.orders enable row level security;

drop policy if exists "restobot_orders_anon_select" on public.orders;
create policy "restobot_orders_anon_select"
  on public.orders for select to anon using (true);

drop policy if exists "restobot_orders_anon_insert" on public.orders;
create policy "restobot_orders_anon_insert"
  on public.orders for insert to anon with check (true);

drop policy if exists "restobot_orders_anon_update" on public.orders;
create policy "restobot_orders_anon_update"
  on public.orders for update to anon using (true) with check (true);

drop policy if exists "restobot_orders_auth_select" on public.orders;
create policy "restobot_orders_auth_select"
  on public.orders for select to authenticated using (true);

drop policy if exists "restobot_orders_auth_insert" on public.orders;
create policy "restobot_orders_auth_insert"
  on public.orders for insert to authenticated with check (true);

drop policy if exists "restobot_orders_auth_update" on public.orders;
create policy "restobot_orders_auth_update"
  on public.orders for update to authenticated using (true) with check (true);
