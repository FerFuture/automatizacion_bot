const { MercadoPagoConfig, Preference } = require("mercadopago");

const accessToken = process.env.MP_ACCESS_TOKEN;
const currencyId = (process.env.MP_CURRENCY_ID || "CLP").toUpperCase();

let preferenceClient = null;
if (accessToken) {
  const client = new MercadoPagoConfig({ accessToken });
  preferenceClient = new Preference(client);
}

async function createPaymentPreference({ orderId, totalAmount, restaurantName }) {
  if (!preferenceClient) {
    throw new Error("MP_ACCESS_TOKEN no configurado.");
  }

  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("El total del pedido debe ser mayor a 0 para generar pago.");
  }

  let preference;
  try {
    preference = await preferenceClient.create({
      body: {
        external_reference: orderId,
        statement_descriptor: "RESTOBOT",
        items: [
          {
            id: orderId,
            title: `Pedido ${restaurantName || "Restaurante"}`,
            quantity: 1,
            currency_id: currencyId,
            unit_price: Number(totalAmount)
          }
        ]
      }
    });
  } catch (error) {
    const msg = String(error?.message || "");
    if (msg.toLowerCase().includes("currency_id invalid")) {
      throw new Error(
        `Mercado Pago rechazo currency_id='${currencyId}'. Configura MP_CURRENCY_ID con una moneda valida para tu cuenta (ej: ARS, CLP, PEN, UYU, BRL, MXN).`
      );
    }
    throw error;
  }

  return preference.init_point;
}

module.exports = {
  createPaymentPreference
};
