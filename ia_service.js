const fs = require("fs");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MAX_AUDIO_SECONDS = 45;

function formatMenu(menuItems) {
  if (!menuItems || !menuItems.length) return "Menu no disponible.";

  return menuItems
    .map((item) => {
      const price = item.price != null ? `$${item.price}` : "precio a consultar";
      const description = item.description ? ` - ${item.description}` : "";
      const tags = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
      return `- ${item.name} (${price})${description}${tags}`;
    })
    .join("\n");
}

function buildRestaurantContextText(context) {
  if (!context || !context.restaurant) {
    return "No se encontro contexto del restaurante.";
  }

  const { restaurant, menuItems } = context;
  const openingHours = restaurant.opening_hours || "No informado";
  const policies = restaurant.policies || "Sin politicas cargadas";

  return [
    `Restaurante: ${restaurant.name || "Sin nombre"}`,
    `Horario: ${openingHours}`,
    `Politicas: ${typeof policies === "string" ? policies : JSON.stringify(policies)}`,
    "Menu:",
    formatMenu(menuItems)
  ].join("\n");
}

function mapHistoryToMessages(history = []) {
  const messages = [];
  history.forEach((entry) => {
    if (entry.user_message) {
      messages.push({ role: "user", content: entry.user_message });
    }
    if (entry.bot_response) {
      messages.push({ role: "assistant", content: entry.bot_response });
    }
  });
  return messages;
}

async function transcribeAudioWithWhisper({ filePath, durationSeconds }) {
  if (!filePath) {
    throw new Error("filePath es obligatorio para transcribir.");
  }

  if (durationSeconds > MAX_AUDIO_SECONDS) {
    return {
      tooLong: true,
      transcript: null,
      maxSeconds: MAX_AUDIO_SECONDS
    };
  }

  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    language: "es"
  });

  return {
    tooLong: false,
    transcript: (result.text || "").trim(),
    maxSeconds: MAX_AUDIO_SECONDS
  };
}

async function generateAssistantResponse({ customerMessage, restaurantContext, chatHistory = [] }) {
  const contextText = buildRestaurantContextText(restaurantContext);
  const restaurantName = restaurantContext?.restaurant?.name || "Restaurante";
  const historyMessages = mapHistoryToMessages(chatHistory);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: [
          `Tu nombre es ${restaurantName}.`,
          "Tenes este menu disponible segun contexto.",
          "Si el cliente pide algo que no esta en la lista, decile amablemente que no contamos con eso.",
          "No limites cantidades salvo que el producto este disponible=false en el contexto.",
          "Si el cliente dice algo de seguimiento como 'quiero dos' o 'si, quiero una', interpreta que se refiere al ultimo producto en conversacion.",
          "Nunca preguntes por alergias. Nunca menciones alergias salvo que el cliente lo pida explicitamente.",
          "El canal YA es WhatsApp: nunca pidas 'enviame por WhatsApp' ni digas que luego escribiras por WhatsApp.",
          "No inventes precios ni productos.",
          "Responde en espanol claro, breve y comercial."
        ].join(" ")
      },
      {
        role: "system",
        content: `Contexto del restaurante y lista_de_productos:\n${contextText}`
      },
      ...historyMessages,
      {
        role: "user",
        content: customerMessage
      }
    ]
  });

  return (completion.choices?.[0]?.message?.content || "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

async function generateOrderQuote({ conversationText, restaurantContext, chatHistory = [] }) {
  const contextText = buildRestaurantContextText(restaurantContext);
  const historyMessages = mapHistoryToMessages(chatHistory);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "Analiza la conversacion del cliente y arma un resumen del pedido solo con productos del menu disponible.",
          "Si el cliente pide algo fuera del menu, no lo incluyas y marca hasOrder=false si no queda ningun item valido.",
          "Si el usuario usa referencias como 'quiero dos' o 'si, quiero una', asocia esa cantidad al ultimo producto discutido en la charla.",
          "No inventes productos ni precios.",
          "Responde SOLO JSON valido con esta estructura:",
          '{"hasOrder": boolean, "details": string, "items": string[], "totalAmount": number, "deliveryAddress": string, "missingItemsMessage": string}'
        ].join(" ")
      },
      {
        role: "system",
        content: `Menu y contexto:\n${contextText}`
      },
      ...historyMessages,
      {
        role: "user",
        content: `Conversacion:\n${conversationText}`
      }
    ]
  });

  const raw = (completion.choices?.[0]?.message?.content || "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {
      hasOrder: false,
      details: "",
      items: [],
      totalAmount: 0,
      deliveryAddress: "",
      missingItemsMessage: "No logre interpretar el pedido con claridad. Confirmame nuevamente los productos."
    };
  }

  return {
    hasOrder: Boolean(parsed.hasOrder),
    details: String(parsed.details || "").trim(),
    items: Array.isArray(parsed.items) ? parsed.items.map((item) => String(item)) : [],
    totalAmount: Number(parsed.totalAmount || 0),
    deliveryAddress: String(parsed.deliveryAddress || "").trim(),
    missingItemsMessage: String(parsed.missingItemsMessage || "").trim()
  };
}

async function detectAddressIntent({ customerMessage, chatHistory = [] }) {
  const historyMessages = mapHistoryToMessages(chatHistory);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          'Detecta si el mensaje del cliente contiene direccion de entrega. Responde SOLO JSON: {"isAddress": boolean, "normalizedAddress": string}.'
      },
      ...historyMessages,
      { role: "user", content: customerMessage }
    ]
  });

  const raw = (completion.choices?.[0]?.message?.content || "").trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      isAddress: Boolean(parsed.isAddress),
      normalizedAddress: String(parsed.normalizedAddress || "").trim()
    };
  } catch (_) {
    return {
      isAddress: false,
      normalizedAddress: ""
    };
  }
}

module.exports = {
  MAX_AUDIO_SECONDS,
  transcribeAudioWithWhisper,
  generateAssistantResponse,
  generateOrderQuote,
  detectAddressIntent
};
