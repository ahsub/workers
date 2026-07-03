/**
 * ko-ai Worker — Rate-Limit-Patch v1.0 (03.07.2026)
 * ==================================================
 * Zweck: KI-Kosten in der Beta-Phase fix und kalkulierbar machen
 * (UIQ-STRATEGIE v1.3, Risikoregister "KI-Kosten-Skalierung").
 *
 * Prinzip: KV-Tageszähler je Token-Hash je Feature. Limits als Konstanten.
 * Fail-open bei KV-Fehlern (Verfügbarkeit vor Sparsamkeit in der Beta).
 *
 * INTEGRATION (CF-Dashboard → Worker ko-ai → Quick Edit):
 * 1. Diesen gesamten Block oberhalb des fetch-Handlers einfügen.
 * 2. Im fetch-Handler NACH erfolgreicher Token-Prüfung (dort, wo der
 *    SHA-256-Hash des Tokens bereits vorliegt — Variable ggf. anpassen)
 *    und VOR dem Anthropic-API-Call einfügen:
 *
 *      const rl = await checkRateLimit(env, tokenHash, feature);
 *      if (!rl.allowed) {
 *        return new Response(JSON.stringify({
 *          error: "rate_limit",
 *          message: `Tageslimit erreicht (${rl.limit}/Tag für ${feature}). Reset um 00:00 UTC.`,
 *          used: rl.used, limit: rl.limit
 *        }), { status: 429, headers: { "Content-Type": "application/json",
 *              "Access-Control-Allow-Origin": "*" } });
 *      }
 *
 * 3. `feature` bestimmen wie bereits im Request-Logging üblich (z. B. aus
 *    Pfad oder Body-Feld; Fallback "default").
 * 4. KV-Binding: nutzt dasselbe Binding wie das Request-Logging.
 *    Name unten in KV_BINDING_NAME anpassen, falls abweichend.
 * 5. Deploy im Dashboard. Test: 6. Deep-Dive-Aufruf desselben Tokens
 *    am selben Tag muss HTTP 429 liefern.
 *
 * WICHTIG: Nach Integration den kompletten Worker-Quellcode aus dem
 * Dashboard kopieren und in dieses Repo (ahsub/workers) committen —
 * Befund "ko-ai-Quellcode unversioniert" (STRATEGIE v1.3, Risikoregister).
 */

/* ── Konfiguration ──────────────────────────────────────────────── */
const KV_BINDING_NAME = "KV"; // ggf. an tatsächlichen Binding-Namen anpassen

const RATE_LIMITS = {
  deepdive:  5,   // Deep-Dive-Analysen pro Token pro Tag
  briefing:  2,   // Morning Briefings pro Token pro Tag
  darkpool:  3,   // Dark-Pool-KI pro Token pro Tag
  default:  10    // alle übrigen KI-Endpunkte zusammen
};

// Admin-/Eigenbedarfs-Ausnahmen: SHA-256-Hashes (hex, lowercase) von Tokens,
// die NICHT limitiert werden (z. B. eigener Betreiber-Token, EIC).
const RATE_LIMIT_EXEMPT_HASHES = [
  // "abc123…", // Betreiber-Token-Hash hier eintragen
];

/* ── Kernfunktion ───────────────────────────────────────────────── */
/**
 * Prüft und inkrementiert den Tageszähler für tokenHash × feature.
 * @param {object} env - Worker-Env (enthält das KV-Binding)
 * @param {string} tokenHash - SHA-256-Hex des Nutzer-Tokens (existiert bereits im Logging)
 * @param {string} feature - "deepdive" | "briefing" | "darkpool" | sonst → "default"
 * @returns {Promise<{allowed: boolean, used: number, limit: number}>}
 */
async function checkRateLimit(env, tokenHash, feature) {
  const kv = env[KV_BINDING_NAME];
  const key = `rl:${new Date().toISOString().slice(0, 10)}:${tokenHash}:${feature}`;
  const limit = RATE_LIMITS[feature] ?? RATE_LIMITS.default;

  if (RATE_LIMIT_EXEMPT_HASHES.includes(tokenHash)) {
    return { allowed: true, used: 0, limit: Infinity };
  }

  try {
    const used = parseInt((await kv.get(key)) || "0", 10);
    if (used >= limit) {
      return { allowed: false, used, limit };
    }
    // 26h-TTL: Schlüssel räumt sich selbst weg, übersteht Mitternachts-Grenzfälle
    await kv.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
    return { allowed: true, used: used + 1, limit };
  } catch (e) {
    // Fail-open: KV-Störung darf die KI-Funktionen nicht lahmlegen (Beta-Politik).
    // Vorfall erscheint im Worker-Log.
    console.error("rate-limit KV error (fail-open):", e?.message || e);
    return { allowed: true, used: -1, limit };
  }
}

/* ── Optional: Nutzungsübersicht für /logs-Admin-Endpoint ───────── */
/**
 * Liefert die heutigen Zählerstände (Prefix-Scan) — kann in den bestehenden
 * /logs-Endpoint eingehängt werden, um KI-Kosten/Nutzer (Phase-1-Pflichtmetrik)
 * ohne Zusatzaufwand abzulesen.
 */
async function rateLimitReport(env) {
  const kv = env[KV_BINDING_NAME];
  const prefix = `rl:${new Date().toISOString().slice(0, 10)}:`;
  const out = [];
  let cursor;
  try {
    do {
      const page = await kv.list({ prefix, cursor });
      for (const k of page.keys) {
        const used = await kv.get(k.name);
        const [, , hash, feature] = k.name.split(":");
        out.push({ tokenHash: hash.slice(0, 12) + "…", feature, used: Number(used) });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (e) {
    console.error("rateLimitReport error:", e?.message || e);
  }
  return out;
}
