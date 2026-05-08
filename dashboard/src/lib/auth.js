import { supabase } from "../supabaseClient";
import {
  deliveryMayLoginToday,
  formatAllowedWeekdaysSentence
} from "./deliverySchedule";

const SESSION_KEY = "restobot_session_v1";

/** Roles que pueden guardarse en sesión (incluye maestro: solo login por env, no alta en BD). */
export const SESSION_ROLES = ["admin", "delivery", "kitchen", "waiter", "maestro"];

/** Roles permitidos en la tabla `dashboard_users`. */
export const DB_USER_ROLES = ["admin", "delivery", "kitchen", "waiter"];

export const ROLE_LABELS = {
  admin: "Restaurante (admin)",
  delivery: "Repartidor (delivery)",
  kitchen: "Cocina",
  waiter: "Mozo",
  maestro: "Maestro"
};

const DASHBOARD_USERS_TABLE = "dashboard_users";
const defaultApiBase = `${window.location.protocol}//${window.location.hostname}:3000`;
const apiBase = import.meta.env.VITE_MESA_API_BASE_URL || defaultApiBase;
const verifyPasswordUrl = `${apiBase ? apiBase.replace(/\/$/, "") : ""}/api/dashboard/password/verify`;

async function verifyPasswordWithApi(password, passwordHash) {
  const res = await fetch(verifyPasswordUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password: String(password || ""),
      passwordHash: String(passwordHash || "")
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error || `Error HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data?.ok === true;
}

function envPasswords() {
  return {
    admin: String(import.meta.env.VITE_ADMIN_PASSWORD || "").trim(),
    delivery: String(import.meta.env.VITE_DELIVERY_PASSWORD || "").trim(),
    kitchen: String(import.meta.env.VITE_KITCHEN_PASSWORD || "").trim(),
    waiter: String(import.meta.env.VITE_WAITER_PASSWORD || "").trim(),
    maestro: String(import.meta.env.VITE_MAESTRO_PASSWORD || "").trim()
  };
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !SESSION_ROLES.includes(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function loginWithTableUser(username, password) {
  const norm = String(username || "")
    .trim()
    .toLowerCase();
  if (!norm) {
    return { ok: false, error: "Ingresá un usuario o usá la contraseña del rol sin completar usuario." };
  }
  const { data, error } = await supabase
    .from(DASHBOARD_USERS_TABLE)
    .select("id, password_hash, role, is_active, delivery_work_weekdays")
    .eq("username", norm)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01" || (error.message || "").includes("does not exist")) {
      return {
        ok: false,
        error: "Acceso de usuarios no disponible. Contactá al administrador."
      };
    }
    return { ok: false, error: `Error de acceso: ${error.message}` };
  }
  if (!data || !data.is_active) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (!DB_USER_ROLES.includes(data.role)) {
    return { ok: false, error: "Rol inválido en la base de datos." };
  }
  let ok = false;
  try {
    ok = await verifyPasswordWithApi(String(password || ""), data.password_hash);
  } catch (e) {
    return { ok: false, error: `No se pudo validar credenciales: ${e?.message || e}` };
  }
  if (!ok) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (
    data.role === "delivery" &&
    !deliveryMayLoginToday(data.delivery_work_weekdays)
  ) {
    const hint = formatAllowedWeekdaysSentence(data.delivery_work_weekdays);
    return {
      ok: false,
      error: `Hoy no podés entrar con esta cuenta de reparto. Días habilitados: ${hint}.`
    };
  }
  const session = {
    role: data.role,
    username: norm,
    userId: data.id,
    loginSource: "db",
    loggedInAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
  }
  return { ok: true, session };
}

function loginWithEnvPassword(role, password) {
  if (!SESSION_ROLES.includes(role)) {
    return { ok: false, error: "Rol inválido." };
  }
  const expected = envPasswords()[role];
  if (!expected) {
    return {
      ok: false,
      error: `No hay acceso configurado para "${ROLE_LABELS[role]}". Contactá al administrador.`
    };
  }
  if (String(password || "") !== expected) {
    return { ok: false, error: "Contraseña incorrecta." };
  }
  const session = {
    role,
    loginSource: "env",
    loggedInAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
  }
  return { ok: true, session };
}

/**
 * Sin usuario: prueba la contraseña contra cada VITE_*_PASSWORD definida; el rol queda en el que coincida.
 * (Si dos roles comparten la misma clave, gana el primero en `SESSION_ROLES`.)
 */
function loginWithEnvPasswordMatchAnyRole(password) {
  const pw = String(password || "");
  for (const role of SESSION_ROLES) {
    const expected = envPasswords()[role];
    if (!expected) continue;
    if (pw !== expected) continue;
    return loginWithEnvPassword(role, password);
  }
  return { ok: false, error: "Contraseña incorrecta." };
}

export async function login(p) {
  const username = String(p?.username || "").trim();
  if (username) {
    return loginWithTableUser(username, p.password);
  }
  if (p?.role) {
    return loginWithEnvPassword(p.role, p.password);
  }
  return loginWithEnvPasswordMatchAnyRole(p.password);
}

export function logout() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
  }
}
