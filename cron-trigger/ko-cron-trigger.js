/**
 * ko-cron-trigger.js — Zuverlässiger Zweit-Trigger für den UIQ Market Aggregator
 * ══════════════════════════════════════════════════════════════════════════
 * Hintergrund: GitHub Actions' eigener `schedule`-Trigger läuft explizit auf
 * "Best Effort"-Basis und kann Läufe ohne Fehlermeldung/Log ersatzlos ausfallen
 * lassen (dokumentiertes GitHub-Verhalten, keine Garantie auf Pünktlichkeit).
 * Bestätigter Ausfall: Nacht 08./09.07.2026 UND 09./10.07.2026 — zwei Tage in
 * Folge. Cloudflare Cron Triggers sind für genau diesen Anwendungsfall gebaut
 * und laufen deutlich zuverlässiger.
 *
 * Funktionsweise:
 *   - scheduled(): läuft 03:37 UTC Mo-Sa (identisch zum GitHub-Cron als
 *     redundanter Trigger — schadet nicht doppelt zu triggern, GitHub würde
 *     einen bereits laufenden Job nicht doppelt starten wenn `concurrency`
 *     gesetzt wäre; aktuell ohne — im Zweifel 2 Läufe statt 0, unkritisch).
 *   - fetch(): manueller Test-Endpoint, geschützt durch Secret-Token in der
 *     Query (?token=...), damit nicht jeder im Internet den Aggregator
 *     manuell anstoßen kann (Worker-URLs sind sonst öffentlich erreichbar).
 *
 * Erforderliches Secret (via `wrangler secret put GITHUB_PAT`):
 *   GITHUB_PAT — Personal Access Token mit `repo`-Scope für ahsub/ko-aggregator
 *   TRIGGER_TOKEN — beliebiges Secret für den manuellen Test-Endpoint
 *
 * Deploy: wrangler deploy (aus diesem Verzeichnis, mit wrangler.toml)
 */

const REPO = 'ahsub/ko-aggregator';
const WORKFLOW_FILE = 'market-aggregator.yml';

async function triggerAggregator(env) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${env.GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'ko-cron-trigger-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });

  const ok = resp.status === 204;
  let detail = '';
  if (!ok) {
    try { detail = await resp.text(); } catch (e) { detail = '(kein Response-Body)'; }
  }

  console.log(`[ko-cron-trigger] Dispatch ${ok ? 'erfolgreich' : 'FEHLGESCHLAGEN'} — HTTP ${resp.status}${detail ? ' — ' + detail : ''}`);
  return { ok, status: resp.status, detail };
}

export default {
  // ── Cron Trigger: läuft 03:37 UTC Mo-Sa ────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      triggerAggregator(env).then((result) => {
        if (!result.ok) {
          console.error('[ko-cron-trigger] Aggregator-Trigger fehlgeschlagen:', result.status, result.detail);
        }
      })
    );
  },

  // ── Manueller Test-Endpoint (geschützt) ─────────────────────────────────
  // Aufruf: https://ko-cron-trigger.<subdomain>.workers.dev/?token=<TRIGGER_TOKEN>
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!env.TRIGGER_TOKEN || token !== env.TRIGGER_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await triggerAggregator(env);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
