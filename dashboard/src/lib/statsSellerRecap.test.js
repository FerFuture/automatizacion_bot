import { describe, expect, it } from "vitest";
import {
  computeSellerRecap,
  dishLinesFromOrder,
  dishesFromOrder,
  localDayKey,
  recapCsvRows,
  sellerFromOrder,
  sellingDayKeys
} from "./statsSellerRecap.js";

describe("sellerFromOrder", () => {
  it("usa el nombre del mozo cuando está en las notas", () => {
    const seller = sellerFromOrder({ notes: "Mozo · Mesa: 4 · Mozo: Ana" });
    expect(seller.key).toBe("waiter:ana");
    expect(seller.label).toBe("Ana");
    expect(seller.kind).toBe("waiter");
  });

  it("agrupa mozos sin usuario", () => {
    const seller = sellerFromOrder({
      notes: "Mozo · Mesa: 2",
      payment_method: "efectivo_mesa"
    });
    expect(seller.label).toBe("Mozo (sin usuario)");
  });

  it("distingue carta mesa QR", () => {
    const seller = sellerFromOrder({
      fulfillment_type: "mesa",
      customer_number: "",
      notes: "Mesa: 5"
    });
    expect(seller.label).toBe("Carta mesa (QR)");
  });

  it("agrupa pedidos de WhatsApp", () => {
    const seller = sellerFromOrder({
      fulfillment_type: "delivery",
      customer_number: "5491112345678",
      notes: "modalidad: delivery"
    });
    expect(seller.label).toBe("WhatsApp");
  });

  it("no trata efectivo en mesa de WhatsApp como mozo", () => {
    const seller = sellerFromOrder({
      fulfillment_type: "mesa",
      customer_number: "5491112345678",
      payment_method: "efectivo_mesa",
      notes: "modalidad: mesa"
    });
    expect(seller.label).toBe("WhatsApp");
  });
});

describe("dishesFromOrder", () => {
  it("suma cantidades y precios por plato", () => {
    const dishes = dishesFromOrder({
      items: [
        { name: "Milanesa", price: 8000 },
        { name: "Milanesa", price: 8000 },
        { name: "Empanadas", price: 3000, qty: 2 }
      ]
    });
    expect(dishes.get("milanesa")).toEqual({ name: "Milanesa", qty: 2, revenue: 16000 });
    expect(dishes.get("empanadas")).toEqual({ name: "Empanadas", qty: 2, revenue: 6000 });
  });

  it("reparte el total si los ítems no tienen precio", () => {
    const dishes = dishesFromOrder({
      items: ["Milanesa", "Milanesa", "Coca"],
      total_price: 9000
    });
    expect(dishes.get("milanesa").qty).toBe(2);
    expect(dishes.get("milanesa").revenue).toBe(6000);
    expect(dishes.get("coca").qty).toBe(1);
    expect(dishes.get("coca").revenue).toBe(3000);
  });

  it("lee nombres en strings", () => {
    expect(dishLinesFromOrder({ items: ["Lomo", "Lomo"] })).toEqual([
      { name: "Lomo", qty: 1, unitPrice: null },
      { name: "Lomo", qty: 1, unitPrice: null }
    ]);
  });
});

describe("computeSellerRecap", () => {
  const today = localDayKey(new Date());
  const orders = [
    {
      created_at: new Date().toISOString(),
      status: "delivered",
      payment_status: "paid",
      notes: "Mozo · Mesa: 3 · Mozo: Ana",
      items: [
        { name: "Milanesa", price: 8000 },
        { name: "Empanadas", price: 3000 }
      ],
      total_price: 11000
    },
    {
      created_at: new Date().toISOString(),
      status: "delivered",
      payment_status: "paid",
      notes: "Mozo · Mesa: 1 · Mozo: Ana",
      items: [{ name: "Milanesa", price: 8000 }],
      total_price: 8000
    },
    {
      created_at: new Date().toISOString(),
      status: "delivered",
      payment_status: "paid",
      fulfillment_type: "delivery",
      customer_number: "54911",
      items: [{ name: "Lomo", price: 12000 }],
      total_price: 12000
    },
    {
      created_at: new Date().toISOString(),
      status: "cancelled",
      payment_status: "cancelled",
      notes: "Mozo · Mesa: 9 · Mozo: Ana",
      items: [{ name: "Milanesa", price: 8000 }],
      total_price: 8000
    }
  ];

  it("resume quién vendió qué, totales y el más vendido", () => {
    const recap = computeSellerRecap(orders, (createdAt) => localDayKey(createdAt) === today);
    expect(recap.orderCount).toBe(3);
    expect(recap.totalRevenue).toBe(31000);
    expect(recap.topDish.name).toBe("Milanesa");
    expect(recap.topDish.qty).toBe(2);
    expect(recap.topDish.revenue).toBe(16000);

    const ana = recap.sellers.find((s) => s.label === "Ana");
    expect(ana.orderCount).toBe(2);
    expect(ana.collected).toBe(19000);
    expect(ana.topDish.name).toBe("Milanesa");
    expect(ana.dishes.map((d) => d.name)).toEqual(["Milanesa", "Empanadas"]);

    const wa = recap.sellers.find((s) => s.label === "WhatsApp");
    expect(wa.collected).toBe(12000);
    expect(wa.dishes[0].name).toBe("Lomo");
  });

  it("lista días con ventas cobradas", () => {
    expect(sellingDayKeys(orders)[0]).toBe(today);
  });

  it("arma filas CSV por vendedor y plato", () => {
    const recap = computeSellerRecap(orders, () => true);
    const rows = recapCsvRows(recap);
    expect(rows.some((row) => row[0] === "Ana" && row[1] === "Milanesa" && row[2] === "2")).toBe(true);
  });
});
