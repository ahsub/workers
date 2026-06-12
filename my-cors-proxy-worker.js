export default {
  async fetch(request, env, ctx) {

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, x-ant-key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response("Fehler: 'url'-Parameter fehlt", {
        status: 400, headers: corsHeaders
      });
    }

    const isYahoo     = targetUrl.includes("yahoo.com");
    const isTwelve    = targetUrl.includes("twelvedata.com");
    const isFinnhub   = targetUrl.includes("finnhub.io");
    const isAnthropic = targetUrl.includes("anthropic.com");

    try {

      // ─── PFAD A: Anthropic API ────────────────────────────────
      if (isAnthropic) {
        // Key aus URL-Parameter ODER x-ant-key Header
        const antKey = url.searchParams.get("ant_key")
          || request.headers.get("x-ant-key")
          || request.headers.get("x-api-key")
          || "";

        if (!antKey) {
          return new Response(
            JSON.stringify({ error: { message: "Kein Anthropic API-Key übergeben" } }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const body = request.method === "POST" ? await request.text() : null;
        const res = await fetch(targetUrl, {
          method: request.method,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": antKey,
            "anthropic-version": "2023-06-01",
          },
          body: body,
        });
        const respBody = await res.text();
        return new Response(respBody, {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      // ─── PFAD B: Twelve Data + Finnhub ───────────────────────
      if (isTwelve || isFinnhub) {
        const res = await fetch(targetUrl, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
        });
        const body = await res.text();
        if (res.status === 429) {
          return new Response(
            JSON.stringify({ error: "rate_limit", message: "API Rate-Limit. Bitte warten." }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(body, {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8",
            "X-Source": isTwelve ? "twelvedata" : "finnhub" }
        });
      }

      // ─── PFAD C: Yahoo Finance ────────────────────────────────
      if (isYahoo) {
        const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
          redirect: "follow",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://finance.yahoo.com/",
          }
        });
        const cookies = [];
        crumbRes.headers.forEach((val, key) => {
          if (key.toLowerCase() === "set-cookie") {
            const nv = val.split(";")[0].trim();
            if (nv.includes("=")) cookies.push(nv);
          }
        });
        const crumb = (await crumbRes.text()).trim();
        const cookieStr = cookies.join("; ");
        const sep = targetUrl.includes("?") ? "&" : "?";
        const finalUrl = (crumb && crumb.length > 2 && crumb.length < 60)
          ? `${targetUrl}${sep}crumb=${encodeURIComponent(crumb)}` : targetUrl;

        const dataRes = await fetch(finalUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://finance.yahoo.com/",
            ...(cookieStr ? { "Cookie": cookieStr } : {}),
          }
        });
        const body = await dataRes.text();
        if (dataRes.status >= 400) {
          return new Response(
            JSON.stringify({ error: "yahoo_error", status: dataRes.status }),
            { status: dataRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(body, {
          status: dataRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "X-Source": "yahoo" }
        });
      }

      // ─── PFAD D: Alle anderen URLs ────────────────────────────
      const res = await fetch(targetUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*" }
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      });

    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};
