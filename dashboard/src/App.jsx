import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const ORDER_STATUS_COLORS = {
  awaiting_payment_method: "bg-violet-500/20 text-violet-300 border border-violet-500/30",
  pending_payment: "bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30",
  pending: "bg-amber-500/20 text-amber-300 border border-amber-500/30",
  confirmed: "bg-blue-500/20 text-blue-300 border border-blue-500/30",
  delivered: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30",
  cancelled: "bg-rose-500/20 text-rose-300 border border-rose-500/30"
};

function currency(value) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS"
  }).format(Number(value));
}

function playNotification() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = 880;
  gain.gain.value = 0.08;
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.15);
}

export default function App() {
  const [activeTab, setActiveTab] = useState("orders");
  const [orders, setOrders] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [savingItemId, setSavingItemId] = useState(null);
  const [savingOrderId, setSavingOrderId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({
    name: "",
    description: "",
    category: "",
    price: ""
  });
  const [error, setError] = useState("");

  const sortedOrders = useMemo(
    () =>
      [...orders].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [orders]
  );

  async function loadOrders(forRestaurantId) {
    const rid = forRestaurantId || restaurantId;
    if (!rid) {
      setOrders([]);
      setLoadingOrders(false);
      return;
    }

    setLoadingOrders(true);
    const { data, error: queryError } = await supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", rid)
      .order("created_at", { ascending: false })
      .limit(100);

    if (queryError) {
      setError(`Error cargando pedidos: ${queryError.message}`);
      setLoadingOrders(false);
      return;
    }

    setOrders(data || []);
    setLoadingOrders(false);
  }

  async function loadMenu() {
    if (!restaurantId) {
      setMenuItems([]);
      setLoadingMenu(false);
      return;
    }

    setLoadingMenu(true);
    const { data, error: queryError } = await supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (queryError) {
      setError(`Error cargando menu: ${queryError.message}`);
      setLoadingMenu(false);
      return;
    }

    setMenuItems(data || []);
    setLoadingMenu(false);
  }

  async function updateOrderStatus(orderId, nextStatus) {
    setSavingOrderId(orderId);
    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: nextStatus })
      .eq("id", orderId);

    if (updateError) {
      setError(`Error actualizando estado del pedido: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) => prev.map((order) => (order.id === orderId ? { ...order, status: nextStatus } : order)));
    setSavingOrderId(null);
  }

  useEffect(() => {
    async function loadRestaurant() {
      const configuredBotNumber = (import.meta.env.VITE_BOT_WHATSAPP_NUMBER || "").replace(/\D/g, "");
      let query = supabase.from("restaurants").select("id, name, whatsapp_number");
      if (configuredBotNumber) {
        query = query.eq("whatsapp_number", configuredBotNumber);
      } else {
        query = query.limit(1);
      }

      const { data, error: restaurantError } = await query.maybeSingle();
      if (restaurantError) {
        setError(`Error resolviendo restaurante: ${restaurantError.message}`);
        return;
      }
      if (!data) {
        setError(
          "No se encontro el restaurante para este dashboard. Configura DASHBOARD_BOT_WHATSAPP_NUMBER en el .env principal."
        );
        return;
      }

      setRestaurantId(data.id);
      setRestaurantName(data.name || "");
    }

    loadRestaurant();
  }, []);

  useEffect(() => {
    if (!restaurantId) return undefined;

    loadOrders(restaurantId);
    loadMenu();

    const channel = supabase
      .channel(`orders-realtime-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`
        },
        (payload) => {
          setOrders((prev) => [payload.new, ...prev]);
          playNotification();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`
        },
        (payload) => {
          setOrders((prev) => prev.map((row) => (row.id === payload.new.id ? payload.new : row)));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [restaurantId]);

  async function updateMenuItem(itemId, values) {
    setSavingItemId(itemId);
    const { error: updateError } = await supabase.from("menu_items").update(values).eq("id", itemId);
    if (updateError) {
      setError(`Error guardando item: ${updateError.message}`);
      setSavingItemId(null);
      return;
    }

    setMenuItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...values } : item)));
    setSavingItemId(null);
  }

  async function createMenuItem(event) {
    event.preventDefault();
    if (!restaurantId) {
      setError("No se pudo identificar el restaurante para guardar el producto.");
      return;
    }

    const price = Number(String(newItem.price).replace(",", "."));
    if (!newItem.name.trim()) {
      setError("El nombre del producto es obligatorio.");
      return;
    }
    if (!Number.isFinite(price)) {
      setError("El precio debe ser un numero valido.");
      return;
    }

    setAddingItem(true);
    const payload = {
      restaurant_id: restaurantId,
      name: newItem.name.trim(),
      description: newItem.description.trim() || null,
      category: newItem.category.trim() || null,
      price,
      available: true
    };

    const { data, error: insertError } = await supabase
      .from("menu_items")
      .insert(payload)
      .select("*")
      .single();

    if (insertError) {
      setError(`Error creando producto: ${insertError.message}`);
      setAddingItem(false);
      return;
    }

    setMenuItems((prev) => [...prev, data]);
    setNewItem({ name: "", description: "", category: "", price: "" });
    setShowAddForm(false);
    setAddingItem(false);
  }

  async function deleteMenuItem(itemId) {
    setSavingItemId(itemId);
    const { error: deleteError } = await supabase.from("menu_items").delete().eq("id", itemId);
    if (deleteError) {
      setError(`Error eliminando producto: ${deleteError.message}`);
      setSavingItemId(null);
      return;
    }

    setMenuItems((prev) => prev.filter((item) => item.id !== itemId));
    setSavingItemId(null);
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">RestoBot Dashboard</h1>
            <p className="text-sm text-slate-400">Gestion de pedidos y menu en tiempo real</p>
            {restaurantName ? (
              <p className="mt-1 text-xs text-slate-500">Restaurante activo: {restaurantName}</p>
            ) : null}
          </div>
          <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
            Realtime activo
          </div>
        </header>

        <div className="mb-5 flex gap-3">
          <button
            type="button"
            onClick={() => setActiveTab("orders")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "orders"
                ? "bg-emerald-500 text-slate-950"
                : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            Pedidos
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("menu")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "menu"
                ? "bg-emerald-500 text-slate-950"
                : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            Gestor de Menu
          </button>
        </div>

        {error ? (
          <div className="mb-5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {error}
          </div>
        ) : null}

        {activeTab === "orders" ? (
          <section className="space-y-4">
            {loadingOrders ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Cargando pedidos...
              </div>
            ) : sortedOrders.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Aun no hay pedidos.
              </div>
            ) : (
              sortedOrders.map((order) => (
                <article key={order.id} className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-slate-200">Pedido #{order.id.slice(0, 8)}</h2>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        ORDER_STATUS_COLORS[order.status] || "bg-slate-700 text-slate-200"
                      }`}
                    >
                      {order.status || "pending"}
                    </span>
                  </div>
                  <div className="grid gap-2 text-sm text-slate-300 md:grid-cols-2">
                    <p>
                      <span className="text-slate-500">Cliente:</span> {order.customer_number || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Metodo pago:</span> {order.payment_method || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Estado pago:</span> {order.payment_status || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Total:</span> {currency(order.total_price ?? order.total_amount)}
                    </p>
                    <p>
                      <span className="text-slate-500">Direccion:</span> {order.address || "-"}
                    </p>
                    <p className="md:col-span-2">
                      <span className="text-slate-500">Fecha:</span>{" "}
                      {order.created_at ? new Date(order.created_at).toLocaleString("es-CL") : "-"}
                    </p>
                    <p className="md:col-span-2">
                      <span className="text-slate-500">Notas:</span> {order.notes || order.raw_request || "-"}
                    </p>
                    <div className="md:col-span-2 mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={savingOrderId === order.id}
                        onClick={() => updateOrderStatus(order.id, "pending")}
                        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-300"
                      >
                        Marcar pendiente
                      </button>
                      <button
                        type="button"
                        disabled={savingOrderId === order.id}
                        onClick={() => updateOrderStatus(order.id, "confirmed")}
                        className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1 text-xs text-blue-300"
                      >
                        Confirmar
                      </button>
                      <button
                        type="button"
                        disabled={savingOrderId === order.id}
                        onClick={() => updateOrderStatus(order.id, "delivered")}
                        className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300"
                      >
                        Entregado
                      </button>
                      <button
                        type="button"
                        disabled={savingOrderId === order.id}
                        onClick={() => updateOrderStatus(order.id, "cancelled")}
                        className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-xs text-rose-300"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
        ) : (
          <section className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900 p-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-200">Productos del menu</h2>
                <p className="text-xs text-slate-400">Administra precios, disponibilidad y alta de productos.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddForm((prev) => !prev)}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
              >
                Añadir Producto
              </button>
            </div>

            {showAddForm ? (
              <form
                onSubmit={createMenuItem}
                className="grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 md:grid-cols-2"
              >
                <input
                  value={newItem.name}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Nombre"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                  required
                />
                <input
                  value={newItem.category}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, category: event.target.value }))}
                  placeholder="Categoria"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                />
                <input
                  value={newItem.price}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, price: event.target.value }))}
                  placeholder="Precio (ej: 5990.50)"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                  required
                />
                <input
                  value={newItem.description}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="Descripcion"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                />
                <div className="md:col-span-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={addingItem}
                    className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
                  >
                    {addingItem ? "Guardando..." : "Guardar producto"}
                  </button>
                </div>
              </form>
            ) : null}

            {loadingMenu ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Cargando menu...
              </div>
            ) : menuItems.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Aun no hay items cargados en menu_items.
              </div>
            ) : (
              menuItems.map((item) => (
                <article
                  key={item.id}
                  className="grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-5 md:grid-cols-[1fr_120px_140px_100px]"
                >
                  <div>
                    <h3 className="font-semibold text-slate-100">{item.name}</h3>
                    <p className="text-sm text-slate-400">{item.category || "Sin categoria"}</p>
                    <p className="mt-1 text-xs text-slate-500">{item.description || "Sin descripcion"}</p>
                  </div>
                  <input
                    type="number"
                    className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                    defaultValue={item.price || 0}
                    onBlur={(event) =>
                      updateMenuItem(item.id, {
                        price: Number(event.target.value || 0)
                      })
                    }
                  />
                  <button
                    type="button"
                    disabled={savingItemId === item.id}
                    onClick={() => updateMenuItem(item.id, { available: !item.available })}
                    className={`h-10 rounded-lg px-3 text-sm font-semibold transition ${
                      item.available
                        ? "bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
                        : "bg-rose-600/20 text-rose-300 hover:bg-rose-600/30"
                    }`}
                  >
                    {item.available ? "Disponible" : "Agotado"}
                  </button>
                  <button
                    type="button"
                    disabled={savingItemId === item.id}
                    onClick={() => deleteMenuItem(item.id)}
                    className="h-10 rounded-lg bg-rose-600/20 px-3 text-sm font-semibold text-rose-300 hover:bg-rose-600/30"
                  >
                    Eliminar
                  </button>
                </article>
              ))
            )}
          </section>
        )}
      </div>
    </div>
  );
}
