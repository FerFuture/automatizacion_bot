import {
  effectiveOrderTotal,
  orderFromWaiterPanelNotes,
  orderIsAnonymousMesaWeb,
  waiterNameFromMozoNotes,
  normalizeOrderStatus,
  paymentIsApproved
} from "./format";

export const SELLER_WHATSAPP = "channel:whatsapp";
export const SELLER_MESA_QR = "channel:mesa_qr";
export const SELLER_WAITER_UNNAMED = "waiter:_unnamed";

export function orderCountsAsSale(order) {
  const st = normalizeOrderStatus(order);
  if (st === "cancelled") return false;
  if (st === "delivered") return true;
  return paymentIsApproved(order);
}

export function localDayKey(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isoDateLabel(key) {
  const [y, m, d] = String(key || "").split("-");
  if (!y || !m || !d) return String(key || "");
  return `${d}/${m}/${y}`;
}

export function weekdayShortLabel(key) {
  const [y, m, d] = String(key || "").split("-").map(Number);
  if (!y || !m || !d) return String(key || "");
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  return date.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit" });
}

export function dayBoundsIso(dayKey) {
  const [y, m, d] = String(dayKey || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

export function sellerFromOrder(order) {
  const waiterName = waiterNameFromMozoNotes(order?.notes);
  if (waiterName) {
    return {
      key: `waiter:${waiterName.toLowerCase()}`,
      label: waiterName,
      kind: "waiter"
    };
  }
  if (orderFromWaiterPanelNotes(order)) {
    return {
      key: SELLER_WAITER_UNNAMED,
      label: "Mozo (sin usuario)",
      kind: "waiter"
    };
  }
  if (orderIsAnonymousMesaWeb(order)) {
    return {
      key: SELLER_MESA_QR,
      label: "Carta mesa (QR)",
      kind: "channel"
    };
  }
  return {
    key: SELLER_WHATSAPP,
    label: "WhatsApp",
    kind: "channel"
  };
}

function itemUnitPrice(it) {
  const price = Number(it?.price ?? it?.unit_price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function itemQty(it) {
  const qty = Number(it?.qty ?? it?.quantity ?? 1);
  if (!Number.isFinite(qty) || qty <= 0) return 1;
  return qty;
}

export function dishLinesFromOrder(order) {
  const raw = order?.items;
  const lines = [];
  if (!Array.isArray(raw)) return lines;

  for (const it of raw) {
    if (typeof it === "string") {
      const name = it.trim();
      if (name) lines.push({ name, qty: 1, unitPrice: null });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const name = String(it.name || it.title || "").trim();
    if (!name) continue;
    lines.push({ name, qty: itemQty(it), unitPrice: itemUnitPrice(it) });
  }
  return lines;
}

function addDish(map, name, qty, revenue) {
  const key = name.toLowerCase();
  const prev = map.get(key) || { name, qty: 0, revenue: 0 };
  prev.qty += qty;
  prev.revenue += revenue;
  if (name && !prev.name) prev.name = name;
  map.set(key, prev);
}

export function dishesFromOrder(order) {
  const lines = dishLinesFromOrder(order);
  const dishes = new Map();
  if (!lines.length) return dishes;

  const allUnpriced = lines.every((line) => line.unitPrice == null);
  const collected = effectiveOrderTotal(order);
  const totalQty = lines.reduce((acc, line) => acc + line.qty, 0) || 1;

  for (const line of lines) {
    let revenue = 0;
    if (line.unitPrice != null) {
      revenue = line.unitPrice * line.qty;
    } else if (allUnpriced && collected > 0) {
      revenue = collected * (line.qty / totalQty);
    }
    addDish(dishes, line.name, line.qty, revenue);
  }
  return dishes;
}

function sortDishes(map) {
  return Array.from(map.values()).sort((a, b) => b.qty - a.qty || b.revenue - a.revenue || a.name.localeCompare(b.name, "es"));
}

function sellerSort(a, b) {
  if (a.kind !== b.kind) return a.kind === "waiter" ? -1 : 1;
  return a.label.localeCompare(b.label, "es");
}

export function sellingDayKeys(orders) {
  const keys = new Set();
  for (const order of orders || []) {
    if (!order?.created_at) continue;
    if (!orderCountsAsSale(order)) continue;
    keys.add(localDayKey(order.created_at));
  }
  return Array.from(keys).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

export function computeSellerRecap(orders, matchesCreatedAt) {
  const sellers = new Map();
  const globalDishes = new Map();
  let totalRevenue = 0;
  let orderCount = 0;

  for (const order of orders || []) {
    if (!order?.created_at) continue;
    if (typeof matchesCreatedAt === "function" && !matchesCreatedAt(order.created_at)) continue;
    if (!orderCountsAsSale(order)) continue;

    const collected = effectiveOrderTotal(order);
    orderCount += 1;
    totalRevenue += collected;

    const seller = sellerFromOrder(order);
    let bucket = sellers.get(seller.key);
    if (!bucket) {
      bucket = {
        key: seller.key,
        label: seller.label,
        kind: seller.kind,
        orderCount: 0,
        collected: 0,
        dishes: new Map()
      };
      sellers.set(seller.key, bucket);
    }
    bucket.orderCount += 1;
    bucket.collected += collected;

    const orderDishes = dishesFromOrder(order);
    for (const dish of orderDishes.values()) {
      addDish(bucket.dishes, dish.name, dish.qty, dish.revenue);
      addDish(globalDishes, dish.name, dish.qty, dish.revenue);
    }
  }

  const dishList = sortDishes(globalDishes);
  const sellerList = Array.from(sellers.values())
    .map((seller) => {
      const dishes = sortDishes(seller.dishes);
      return {
        key: seller.key,
        label: seller.label,
        kind: seller.kind,
        orderCount: seller.orderCount,
        collected: seller.collected,
        dishes,
        topDish: dishes[0] || null
      };
    })
    .sort(sellerSort);

  return {
    orderCount,
    totalRevenue,
    dishes: dishList,
    topDish: dishList[0] || null,
    sellers: sellerList
  };
}

export function recapCsvRows(recap) {
  const rows = [];
  for (const seller of recap.sellers || []) {
    if (!seller.dishes.length) {
      rows.push([
        seller.label,
        "",
        "0",
        "0.00",
        String(seller.orderCount),
        seller.collected.toFixed(2),
        seller.topDish?.name || ""
      ]);
      continue;
    }
    for (const dish of seller.dishes) {
      rows.push([
        seller.label,
        dish.name,
        String(dish.qty),
        dish.revenue.toFixed(2),
        String(seller.orderCount),
        seller.collected.toFixed(2),
        seller.topDish?.name || ""
      ]);
    }
  }
  return rows;
}
