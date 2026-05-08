import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { signMesaTableToken } from "../lib/mesaQrToken";

/**
 * Gestión de URLs del panel cliente por mesa (para QR). Misma ruta /carta para todos;
 * la mesa va en ?mesa=N y el token en ?t=... Visible en Admin (menú) y Maestro.
 */
export default function MesaQrLinksPanel({
  restaurantId,
  tableCount,
  qrModuleEnabled
}) {
  const secret = String(import.meta.env.VITE_MESA_QR_SECRET || "").trim();
  const defaultBase =
    String(import.meta.env.VITE_PUBLIC_DASHBOARD_URL || "").trim() ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const [baseUrl, setBaseUrl] = useState(defaultBase);
  const [rows, setRows] = useState([]);
  const [previewTable, setPreviewTable] = useState(1);
  const [qrPreviewUrl, setQrPreviewUrl] = useState("");

  const n = useMemo(() => {
    const t = Number(tableCount);
    if (!Number.isFinite(t) || t < 1) return 0;
    return Math.min(500, Math.floor(t));
  }, [tableCount]);

  useEffect(() => {
    if (n >= 1 && (previewTable < 1 || previewTable > n)) {
      setPreviewTable((t) => (t < 1 || t > n ? 1 : t));
    }
  }, [n, previewTable]);

  useEffect(() => {
    let cancelled = false;
    const rid = String(restaurantId || "").trim();
    if (!rid || !n || !qrModuleEnabled) {
      setRows([]);
      return undefined;
    }
    const base = String(baseUrl || "").replace(/\/$/, "");

    (async () => {
      const out = [];
      for (let table = 1; table <= n; table += 1) {
        let url = `${base}/carta?mesa=${encodeURIComponent(String(table))}`;
        if (secret) {
          const tok = await signMesaTableToken(rid, table, secret);
          if (tok) url += `&t=${encodeURIComponent(tok)}`;
        }
        out.push({ table, url });
      }
      if (!cancelled) setRows(out);
    })();

    return () => {
      cancelled = true;
    };
  }, [restaurantId, n, baseUrl, secret, qrModuleEnabled]);

  useEffect(() => {
    let cancelled = false;
    const row = rows.find((r) => r.table === previewTable);
    if (!row?.url) {
      setQrPreviewUrl("");
      return undefined;
    }
    QRCode.toDataURL(row.url, {
      margin: 1,
      width: 240,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" }
    })
      .then((dataUrl) => {
        if (!cancelled) setQrPreviewUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrPreviewUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [rows, previewTable]);

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }

  if (!qrModuleEnabled) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="text-sm font-semibold text-slate-200">QR / pedido por mesa</h3>
        <p className="mt-2 text-xs text-slate-500">
          Activá <strong className="text-slate-400">Carta y QR mesas</strong> en el módulo Maestro para generar enlaces.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Carta y QR por mesa</h3>
        <p className="mt-1 text-xs text-slate-500 leading-relaxed">
          Todos los clientes usan la misma ruta <code className="rounded bg-slate-950 px-1 text-[11px] text-violet-200">/carta</code>
          ; cada QR añade <code className="rounded bg-slate-950 px-1 text-[11px] text-violet-200">mesa</code> y, si está
          configurado, un token para que el pedido a cocina quede en esa mesa. La ruta antigua{" "}
          <code className="rounded bg-slate-950 px-1 text-[11px] text-slate-400">/mesa/N</code> sigue funcionando.
        </p>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="text-slate-400">URL base del panel (sin barra final)</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="Ej: https://tudominio.com o http://IP:5174"
          className="h-10 w-full max-w-xl rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
        />
        <span className="block text-xs text-slate-500">
          Podés definir <code className="text-[11px]">VITE_PUBLIC_DASHBOARD_URL</code> al construir el dashboard.
        </span>
      </label>

      {!secret ? (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          Falta secreto: para usar pedido por QR sin que puedan cambiar de mesa, tenés que configurar{" "}
          <code className="text-[11px]">MESA_QR_SECRET</code> en el servidor y{" "}
          <code className="text-[11px]">VITE_MESA_QR_SECRET</code> (mismo valor) en el build del dashboard.
        </p>
      ) : (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-100/95">
          Token activo: el servidor solo acepta pedidos si el token coincide con restaurante y mesa.
        </p>
      )}

      {!restaurantId || n < 1 ? (
        <p className="text-sm text-slate-500">Definí la cantidad de mesas para generar enlaces y QR.</p>
      ) : (
        <>
          <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4 sm:flex-row sm:items-start">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-400">Vista previa — elegí la mesa</label>
              <select
                value={previewTable}
                onChange={(e) => setPreviewTable(Number(e.target.value))}
                className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              >
                {rows.map((row) => (
                  <option key={row.table} value={row.table}>
                    Mesa {row.table}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    const row = rows.find((r) => r.table === previewTable);
                    if (row) copy(row.url);
                  }}
                  className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                >
                  Copiar enlace
                </button>
              </div>
            </div>
            <div className="flex flex-col items-center gap-2 sm:ml-auto">
              {qrPreviewUrl ? (
                <img
                  src={qrPreviewUrl}
                  alt={`QR mesa ${previewTable}`}
                  className="rounded-lg border border-slate-700 bg-white p-2"
                  width={240}
                  height={240}
                />
              ) : (
                <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
                  Generando…
                </div>
              )}
              <p className="max-w-[240px] text-center text-[11px] text-slate-500">
                Imprimí o mostrá este código; al escanearlo se abre la carta y los pedidos van a esta mesa.
              </p>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-950/95 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Mesa</th>
                  <th className="px-3 py-2">Enlace</th>
                  <th className="px-3 py-2 w-24">Copiar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.table} className="border-t border-slate-800/80">
                    <td className="px-3 py-2 font-semibold text-slate-200">{row.table}</td>
                    <td className="px-3 py-2 break-all font-mono text-[11px] text-slate-400">{row.url}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => copy(row.url)}
                        className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                      >
                        Copiar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
