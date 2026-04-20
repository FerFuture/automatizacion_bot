require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const {
  getRestaurantByIncomingNumber,
  getRestaurantContext,
  getAvailableMenuItems,
  getRecentInteractions,
  saveInteraction,
  saveOrder
} = require("./database");
const {
  MAX_AUDIO_SECONDS,
  transcribeAudioWithWhisper,
  generateAssistantResponse,
  generateOrderQuote,
  detectAddressIntent
} = require("./ia_service");
const { createPaymentPreference } = require("./payment_service");

const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth";
const TEMP_AUDIO_DIR = path.resolve(process.cwd(), "tmp_audio");
const MIN_TEXT_LENGTH = 3;
const checkoutSessions = new Map();
const conversationState = new Map();

function normalizeNumber(raw) {
  return (raw || "").toString().replace(/[^0-9]/g, "");
}

function extractIncomingBotNumber(message) {
  return normalizeNumber((message.to || "").split("@")[0]);
}

function extractCustomerNumber(message) {
  return normalizeNumber((message.from || "").split("@")[0]);
}

function isEmojiOnly(text) {
  const cleaned = (text || "").replace(/\s/g, "");
  if (!cleaned) return false;
  return /^(\p{Extended_Pictographic}|\uFE0F)+$/u.test(cleaned);
}

function resolveIncomingBotNumber(message, waClient) {
  const fromMessageTo = extractIncomingBotNumber(message);
  if (fromMessageTo) return fromMessageTo;

  const fromClientInfo = normalizeNumber(waClient?.info?.wid?.user);
  if (fromClientInfo) return fromClientInfo;

  return "";
}

function shouldIgnoreTextMessage(text) {
  const normalized = (text || "").trim();
  if (normalized.length < MIN_TEXT_LENGTH) return true;
  if (isEmojiOnly(normalized)) return true;
  return false;
}

function looksLikePhysicalAddress(text) {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return false;

  const hasStreetHint = /\b(calle|av|avenida|pasaje|pasillo|camino|direccion|dirección|entre|nro|numero|número|#)\b/.test(
    normalized
  );
  const hasNumber = /\d{1,4}/.test(normalized);
  const longEnough = normalized.length >= 12;

  return (hasStreetHint && longEnough) || (hasStreetHint && hasNumber);
}

function isConfirmedAddress(addressCheck, originalText) {
  if (!addressCheck?.isAddress) return false;
  const candidate = addressCheck.normalizedAddress || originalText || "";
  return looksLikePhysicalAddress(candidate);
}

function extractAudioDurationSeconds(message) {
  const rawDataSeconds = Number(message?._data?.seconds);
  const rawDataDuration = Number(message?._data?.duration);
  if (Number.isFinite(rawDataSeconds) && rawDataSeconds > 0) return rawDataSeconds;
  if (Number.isFinite(rawDataDuration) && rawDataDuration > 0) return rawDataDuration;
  return 0;
}

const INTENT_PHRASES = {
  closeOrder: [
    "eso es todo",
    "es todo",
    "solo eso",
    "nada mas",
    "nada mas",
    "ya no mas",
    "ya no ma",
    "nomas",
    "no ma",
    "finalizar pedido",
    "cerrar pedido",
    "terminamos"
  ],
  confirmSelection: ["si quiero", "si dame", "confirmo", "ok", "dale", "listo", "perfecto", "si por favor", "si"],
  addMore: ["agregar", "anadir", "añadir", "sumar", "otra", "otro", "mas", "más"],
  noMore: ["no", "no gracias", "solo eso", "es todo", "continuar", "listo"],
  delivery: ["delivery", "domicilio", "envio", "envio a domicilio", "a mi casa", "para la casa", "a casa"],
  local: ["local", "comer en el local", "retiro", "retirar", "paso a buscar", "voy al local", "para llevar"],
  cash: ["efectivo"],
  mercadoPago: ["mercado pago", "mp"]
};

function hasAnyPhrase(text, phrases = []) {
  const normalized = normalizeTextForMatch(text);
  return phrases.some((phrase) => normalized.includes(normalizeTextForMatch(phrase)));
}

function numericOption(text) {
  const normalized = (text || "").trim();
  if (/^1(?:\D.*)?$/.test(normalized)) return 1;
  if (/^2(?:\D.*)?$/.test(normalized)) return 2;
  return null;
}

function wantsToCloseOrder(text) {
  return hasAnyPhrase(text, INTENT_PHRASES.closeOrder);
}

function wantsToConfirmSelection(text) {
  return hasAnyPhrase(text, INTENT_PHRASES.confirmSelection);
}

function getConversationKey(tenantId, customerNumber, botNumber) {
  // Usar una clave estable por restaurante+cliente evita perder el estado cuando
  // WhatsApp cambia el formato de `message.to` entre mensajes.
  return `${tenantId}:${customerNumber}`;
}

function getOrCreateSession(conversationKey) {
  const existing = checkoutSessions.get(conversationKey);
  if (existing) return existing;

  const fresh = {
    status: "browsing",
    details: "",
    items: [],
    totalAmount: 0,
    fulfillmentType: "",
    deliveryAddress: "",
    conversationText: ""
  };
  checkoutSessions.set(conversationKey, fresh);
  return fresh;
}

function formatTotal(totalAmount) {
  return `$${new Intl.NumberFormat("es-CL").format(Math.round(Number(totalAmount) || 0))}`;
}

function buildFulfillmentQuestion(totalAmount) {
  return `¡Recibido! El total de tu pedido es ${formatTotal(
    totalAmount
  )}. ¿Cómo preferís recibirlo?\n1. Delivery\n2. Comer en el local`;
}

function buildPaymentQuestion(details, totalAmount) {
  return `¡Recibido! El total por ${details} es ${formatTotal(
    totalAmount
  )}. ¿Cómo preferís pagar?\n1. Efectivo al recibir\n2. Mercado Pago`;
}

function buildAddMoreQuestion(details, totalAmount) {
  return `Perfecto, llevo en tu pedido: ${details} (total ${formatTotal(
    totalAmount
  )}). ¿Querés agregar algo más?\n1. Sí, agregar más productos\n2. No, continuar`;
}

function detectFulfillmentIntent(text) {
  if (hasAnyPhrase(text, INTENT_PHRASES.delivery)) return "delivery";
  if (hasAnyPhrase(text, INTENT_PHRASES.local)) return "local";
  return null;
}

function normalizeTextForMatch(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function detectDirectMenuOrder(text, menuItems = []) {
  const normalizedMessage = normalizeTextForMatch(text);
  if (!/\b(quiero|dame|me das|pedido|para mi|para mí)\b/.test(normalizedMessage)) {
    return null;
  }

  const matchedItem = (menuItems || []).find((item) => {
    const normalizedName = normalizeTextForMatch(item?.name);
    return normalizedName && normalizedMessage.includes(normalizedName);
  });

  if (!matchedItem) return null;

  const amount = Number(matchedItem.price || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    details: matchedItem.name,
    items: [matchedItem.name],
    totalAmount: amount
  };
}

function isShortOptionMessage(text) {
  const option = numericOption(text);
  if (option === 1 || option === 2) return true;
  return hasAnyPhrase(text, [
    ...INTENT_PHRASES.confirmSelection,
    ...INTENT_PHRASES.noMore,
    ...INTENT_PHRASES.cash,
    ...INTENT_PHRASES.mercadoPago,
    ...INTENT_PHRASES.delivery,
    ...INTENT_PHRASES.localbui
  ]);
}

async function ensureTempDir() {
  await fs.mkdir(TEMP_AUDIO_DIR, { recursive: true });
}

async function handleAudioMessage(message, restaurantContext, tenant, customerNumber, botNumber, recentHistory) {
  const media = await message.downloadMedia();
  if (!media || !media.data) {
    return "No pude procesar el audio. Podrias reenviarlo, por favor?";
  }

  const durationSeconds = extractAudioDurationSeconds(message);
  if (durationSeconds > MAX_AUDIO_SECONDS) {
    return `Tu audio dura mas de ${MAX_AUDIO_SECONDS} segundos. Enviame uno mas corto para poder ayudarte rapido.`;
  }

  const extension = (media.mimetype || "").includes("ogg") ? "ogg" : "mp3";
  const tmpFilePath = path.join(TEMP_AUDIO_DIR, `${Date.now()}-${customerNumber}.${extension}`);

  await fs.writeFile(tmpFilePath, media.data, { encoding: "base64" });

  try {
    const transcription = await transcribeAudioWithWhisper({
      filePath: tmpFilePath,
      durationSeconds
    });

    if (transcription.tooLong) {
      return `Tu audio dura mas de ${transcription.maxSeconds} segundos. Enviame uno mas corto para continuar.`;
    }

    const transcriptText = transcription.transcript || "No se pudo transcribir el audio.";
    if (!transcriptText || transcriptText.length < 2) {
      return "No pude entender bien el audio. Podrias repetirlo en otro audio o por texto?";
    }

    // Enrutamos el audio transcrito por el mismo flujo de checkout de texto
    // para mantener consistencia (agregar items, delivery/local, direccion, pago).
    return handleTextMessage(
      { body: transcriptText },
      restaurantContext,
      tenant,
      customerNumber,
      botNumber,
      recentHistory
    );
  } finally {
    fs.unlink(tmpFilePath).catch(() => null);
  }
}

async function handleTextMessage(message, restaurantContext, tenant, customerNumber, botNumber, recentHistory) {
  const text = message.body || "";
  const trimmedText = text.trim();
  const conversationKey = getConversationKey(tenant.id, customerNumber, botNumber);
  const previousMessages = conversationState.get(conversationKey) || [];
  const updatedMessages = [...previousMessages, text].slice(-20);
  conversationState.set(conversationKey, updatedMessages);
  const session = getOrCreateSession(conversationKey);
  const addressCheck = await detectAddressIntent({
    customerMessage: text,
    chatHistory: recentHistory
  });
  const hasConfirmedAddress = isConfirmedAddress(addressCheck, text);
  const fulfillmentIntent = detectFulfillmentIntent(trimmedText);
  const option = numericOption(trimmedText);

  // Recupera el flujo si llega una opcion corta aunque el estado previo se haya desfasado.
  if (session.totalAmount > 0 && session.status === "browsing") {
    if (option === 1 || fulfillmentIntent === "delivery") {
      session.status = "awaiting_fulfillment";
    } else if (option === 2 || fulfillmentIntent === "local") {
      session.status = "awaiting_fulfillment";
    }
  }

  if (session.status === "awaiting_add_more") {
    if (wantsToCloseOrder(text) || option === 2 || hasAnyPhrase(text, INTENT_PHRASES.noMore)) {
      session.status = "awaiting_fulfillment";
      const fulfillmentQuestion = buildFulfillmentQuestion(session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: fulfillmentQuestion,
        metadata: { status: "awaiting_fulfillment", details: session.details, totalAmount: session.totalAmount }
      });
      return fulfillmentQuestion;
    }

    if (option === 1 || hasAnyPhrase(text, [...INTENT_PHRASES.confirmSelection, ...INTENT_PHRASES.addMore])) {
      session.status = "browsing";
      const addMoreReply = "Perfecto, decime qué más querés agregar. Cuando termines, escribí 'eso es todo'.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: addMoreReply,
        metadata: { status: "browsing" }
      });
      return addMoreReply;
    }

    if (option === 2 || hasAnyPhrase(text, INTENT_PHRASES.noMore)) {
      session.status = "awaiting_fulfillment";
      const fulfillmentQuestion = buildFulfillmentQuestion(session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: fulfillmentQuestion,
        metadata: { status: "awaiting_fulfillment", details: session.details, totalAmount: session.totalAmount }
      });
      return fulfillmentQuestion;
    }

    const invalidAddMoreReply = "No entendí tu opción. Responde 1 para agregar más productos o 2 para continuar.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: invalidAddMoreReply,
      metadata: { status: "awaiting_add_more", invalidChoice: true }
    });
    return invalidAddMoreReply;
  }

  if (session.status === "awaiting_fulfillment") {
    if (option === 1 || fulfillmentIntent === "delivery") {
      session.fulfillmentType = "delivery";
      if (hasConfirmedAddress) {
        session.deliveryAddress = addressCheck.normalizedAddress || text;
      }

      if (!session.deliveryAddress) {
        session.status = "awaiting_address";
        const askAddress =
          "Perfecto. Para delivery necesito tu direccion exacta de entrega (calle y numero).";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: askAddress,
          metadata: { status: "awaiting_address", fulfillmentType: "delivery" }
        });
        return askAddress;
      }

      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(session.details, session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: {
          status: "awaiting_payment",
          fulfillmentType: "delivery",
          details: session.details,
          totalAmount: session.totalAmount
        }
      });
      return paymentQuestion;
    }

    if (option === 2 || fulfillmentIntent === "local") {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(session.details, session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: {
          status: "awaiting_payment",
          fulfillmentType: "local",
          details: session.details,
          totalAmount: session.totalAmount
        }
      });
      return paymentQuestion;
    }

    if (hasAnyPhrase(text, INTENT_PHRASES.addMore)) {
      session.status = "browsing";
      const addMoreReply = "Perfecto, decime qué más querés agregar. Cuando termines, escribí 'eso es todo'.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: addMoreReply,
        metadata: { status: "browsing" }
      });
      return addMoreReply;
    }

    const invalidFulfillmentReply = "No entendi tu opcion. Responde 1 para Delivery o 2 para Comer en el local.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: invalidFulfillmentReply,
      metadata: { status: "awaiting_fulfillment", invalidChoice: true }
    });
    return invalidFulfillmentReply;
  }

  if (session.status === "awaiting_payment") {
    if (option === 1 || hasAnyPhrase(text, INTENT_PHRASES.cash)) {
      const order = await saveOrder({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        items: session.items?.length ? session.items : [session.details],
        notes: `Detalle: ${session.details} | Modalidad: ${
          session.fulfillmentType === "local" ? "comer_en_local" : "delivery"
        }${session.deliveryAddress ? ` | Direccion: ${session.deliveryAddress}` : ""}`,
        address: session.deliveryAddress || null,
        rawRequest: session.conversationText,
        status: "pending",
        paymentMethod: "efectivo",
        paymentStatus: "pending",
        totalAmount: session.totalAmount
      });

      const cashReply = "Perfecto, pago en efectivo al recibir. Tu pedido quedo registrado y en preparacion.";

      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: cashReply,
        metadata: {
          orderId: order.id,
          paymentChoice: "cash",
          fulfillmentType: session.fulfillmentType || "delivery",
          details: session.details
        }
      });

      session.status = "completed";
      return cashReply;
    }

    if (option === 2 || hasAnyPhrase(text, INTENT_PHRASES.mercadoPago)) {
      if (!session.totalAmount || session.totalAmount <= 0) {
        const missingTotalReply = "No pude calcular el total del pedido. Revisa los productos y volve a cerrar el pedido.";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: missingTotalReply,
          metadata: { paymentChoice: "mercadopago_missing_total" }
        });
        return missingTotalReply;
      }

      const order = await saveOrder({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        items: session.items?.length ? session.items : [session.details],
        notes: `Detalle: ${session.details} | Modalidad: ${
          session.fulfillmentType === "local" ? "comer_en_local" : "delivery"
        }${session.deliveryAddress ? ` | Direccion: ${session.deliveryAddress}` : ""}`,
        address: session.deliveryAddress || null,
        rawRequest: session.conversationText,
        status: "pending",
        paymentMethod: "mercadopago",
        paymentStatus: "pending",
        totalAmount: session.totalAmount
      });

      let paymentUrl;
      try {
        paymentUrl = await createPaymentPreference({
          orderId: order.id,
          totalAmount: session.totalAmount,
          restaurantName: tenant.name
        });
      } catch (mpError) {
        const mpErrorReply = `No pude generar el link de Mercado Pago. ${mpError.message || ""}`.trim();
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: `${mpErrorReply} Si queres, responde 1 para pagar en efectivo al recibir.`,
          metadata: { orderId: order.id, paymentChoice: "mercadopago_error", error: String(mpError.message || mpError) }
        });
        return `${mpErrorReply}\nSi queres, responde 1 para pagar en efectivo al recibir.`;
      }

      const mpReply = `Perfecto. Para completar tu pago con Mercado Pago usa este link:\n${paymentUrl}`;

      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: mpReply,
        metadata: {
          orderId: order.id,
          paymentChoice: "mercadopago",
          fulfillmentType: session.fulfillmentType || "delivery",
          details: session.details
        }
      });

      session.status = "completed";
      return mpReply;
    }

    const invalidOptionReply = "No entendi tu opcion. Responde 1 para Efectivo o 2 para Mercado Pago.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: invalidOptionReply,
      metadata: { paymentChoice: "invalid" }
    });
    return invalidOptionReply;
  }

  if (session.status === "awaiting_address" && session.totalAmount > 0) {
    if (hasConfirmedAddress) {
      session.deliveryAddress = addressCheck.normalizedAddress || text;
      session.status = "awaiting_payment";

      const paymentQuestion = buildPaymentQuestion(session.details, session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: {
          status: "awaiting_payment",
          fulfillmentType: "delivery",
          details: session.details,
          totalAmount: session.totalAmount
        }
      });

      return paymentQuestion;
    }

    const askAddressAgain =
      "Perfecto. Para cerrar el pedido necesito tu direccion exacta de entrega (calle y numero).";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: askAddressAgain
    });
    return askAddressAgain;
  }

  if (session.status === "browsing" && session.items?.length && session.totalAmount > 0) {
    if (hasConfirmedAddress) {
      session.fulfillmentType = "delivery";
      session.deliveryAddress = addressCheck.normalizedAddress || text;
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(session.details, session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: {
          status: "awaiting_payment",
          fulfillmentType: "delivery",
          details: session.details,
          totalAmount: session.totalAmount
        }
      });
      return paymentQuestion;
    }

    if (fulfillmentIntent === "delivery") {
      session.fulfillmentType = "delivery";
      session.status = "awaiting_address";
      const askAddress = "Perfecto. Para delivery necesito tu direccion exacta de entrega (calle y numero).";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: askAddress,
        metadata: { status: "awaiting_address", fulfillmentType: "delivery" }
      });
      return askAddress;
    }

    if (fulfillmentIntent === "local") {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(session.details, session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: {
          status: "awaiting_payment",
          fulfillmentType: "local",
          details: session.details,
          totalAmount: session.totalAmount
        }
      });
      return paymentQuestion;
    }
  }

  const directOrder = detectDirectMenuOrder(text, restaurantContext?.menuItems || []);
  if (directOrder) {
    session.totalAmount = directOrder.totalAmount;
    session.details = directOrder.details;
    session.items = directOrder.items;
    session.fulfillmentType = "";
    session.conversationText = updatedMessages.join(" | ");
    if (hasConfirmedAddress) {
      session.deliveryAddress = addressCheck.normalizedAddress || text;
    }

    session.status = "awaiting_add_more";
    const addMoreQuestion = buildAddMoreQuestion(session.details, session.totalAmount);
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: addMoreQuestion,
      metadata: {
        status: "awaiting_add_more",
        details: session.details,
        totalAmount: session.totalAmount
      }
    });

    return addMoreQuestion;
  }

  if (wantsToCloseOrder(text) || wantsToConfirmSelection(text) || hasConfirmedAddress) {
    const quote = await generateOrderQuote({
      conversationText: updatedMessages.join("\n"),
      restaurantContext,
      chatHistory: recentHistory
    });

    if (!quote.hasOrder || !quote.totalAmount || quote.totalAmount <= 0) {
      if (session.items?.length && session.totalAmount > 0) {
        const keepSessionReply = "Ya tengo tu pedido cargado. Responde 1 para Delivery o 2 para Comer en el local.";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: keepSessionReply,
          metadata: {
            status: "awaiting_fulfillment",
            details: session.details,
            totalAmount: session.totalAmount
          }
        });
        session.status = "awaiting_fulfillment";
        return keepSessionReply;
      }

      const fallbackReply =
        quote.missingItemsMessage ||
        "No logre identificar un pedido valido con productos del menu. Decime que productos queres pedir.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: fallbackReply
      });
      return fallbackReply;
    }

    session.status = "awaiting_add_more";
    session.totalAmount = quote.totalAmount;
    session.details = quote.details || "tu pedido";
    session.items = quote.items || [];
    session.fulfillmentType = "";
    session.deliveryAddress = quote.deliveryAddress || (hasConfirmedAddress ? addressCheck.normalizedAddress || text : "");
    session.conversationText = updatedMessages.join(" | ");

    const addMoreQuestion = buildAddMoreQuestion(session.details, session.totalAmount);
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: addMoreQuestion,
      metadata: { status: "awaiting_add_more", details: quote.details, totalAmount: quote.totalAmount }
    });

    return addMoreQuestion;
  }

  // Si ya hay un pedido armado, evitamos volver al asistente generico.
  if (session.items?.length && session.totalAmount > 0) {
    const activeOrderReply =
      "Ya tengo tu pedido cargado. Responde 1 para agregar más productos o 2 para continuar.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: activeOrderReply,
      metadata: { status: "awaiting_add_more", details: session.details, totalAmount: session.totalAmount }
    });
    session.status = "awaiting_add_more";
    return activeOrderReply;
  }

  if (isShortOptionMessage(trimmedText)) {
    const helpReply =
      "Todavia no tengo un pedido activo para esa opcion. Decime que producto queres pedir y te guio paso a paso.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: helpReply,
      metadata: { status: "browsing", shortOptionWithoutSession: true }
    });
    return helpReply;
  }

  const answer = await generateAssistantResponse({
    customerMessage: text,
    restaurantContext,
    chatHistory: recentHistory
  });

  await saveInteraction({
    restaurantId: tenant.id,
    customerNumber,
    botNumber,
    messageType: "text",
    userMessage: text,
    botResponse: answer
  });

  return answer;
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: process.env.WWEBJS_CLIENT_ID || "restobot-main",
    dataPath: AUTH_PATH
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

client.on("qr", (qr) => {
  console.log("Escanea el QR para iniciar sesion:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("WhatsApp conectado y listo.");
});

client.on("authenticated", () => {
  console.log("Sesion autenticada correctamente.");
});

client.on("auth_failure", (error) => {
  console.error("Fallo de autenticacion:", error);
});

client.on("disconnected", (reason) => {
  console.error("Cliente desconectado:", reason);
});

client.on("message", async (message) => {
  try {
    if (message.fromMe) return;
    if (message.type === "sticker") return;

    const botNumber = resolveIncomingBotNumber(message, client);
    const customerNumber = extractCustomerNumber(message);

    const tenant = await getRestaurantByIncomingNumber(botNumber);
    if (!tenant) {
      console.warn("Tenant no encontrado para numero entrante:", {
        botNumber,
        messageTo: message.to,
        clientWid: client?.info?.wid?.user
      });
      await message.reply("No tengo configurado este numero para ningun restaurante.");
      return;
    }

    const restaurantContext = await getRestaurantContext(tenant.id);
    if (!restaurantContext) {
      await message.reply("No pude cargar la informacion del restaurante en este momento.");
      return;
    }
    const availableMenuItems = await getAvailableMenuItems(tenant.id);
    const iaContext = {
      ...restaurantContext,
      menuItems: availableMenuItems
    };
    const recentHistory = await getRecentInteractions({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      limit: 6
    });

    let replyText = null;

    if (message.hasMedia && message.type === "ptt") {
      replyText = await handleAudioMessage(
        message,
        iaContext,
        tenant,
        customerNumber,
        botNumber,
        recentHistory
      );
    } else if (message.type === "chat") {
      const conversationKey = getConversationKey(tenant.id, customerNumber, botNumber);
      const activeSession = getOrCreateSession(conversationKey);
      const normalizedBody = (message.body || "").trim();
      const isKnownShortOption = /^(1|2|si|sí|no|ok|mp|delivery|local)$/i.test(normalizedBody);
      const expectingShortReply = ["awaiting_payment", "awaiting_fulfillment", "awaiting_add_more"].includes(
        activeSession.status
      );
      if (shouldIgnoreTextMessage(message.body) && !expectingShortReply && !isKnownShortOption) return;
      replyText = await handleTextMessage(
        message,
        iaContext,
        tenant,
        customerNumber,
        botNumber,
        recentHistory
      );
    } else {
      return;
    }

    if (replyText) {
      await message.reply(replyText);
    }
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    try {
      await message.reply("Tuve un problema tecnico procesando tu mensaje. Intenta de nuevo.");
    } catch (_) {
      // Ignora fallos de respuesta secundarios
    }
  }
});

ensureTempDir()
  .then(() => client.initialize())
  .catch((error) => {
    console.error("No se pudo inicializar el bot:", error);
    process.exit(1);
  });
