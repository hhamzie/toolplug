// workers/cron/src/index.ts
/// <reference types="@cloudflare/workers-types" />

interface Env {
    DOMAIN: string;
    ADMIN_API_KEY: string; // coming from the Worker’s dashboard secret/vars
  }
  
  const WEEKLY_PATH  = "/api/generate-weekly";
  const MONTHLY_PATH = "/api/generate-monthly";
  const DAILY_PATH   = "/api/send";
  
  // DST-safe 2:00 PM America/New_York gate
  function isTwoPmNY(now = new Date()) {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = Object.fromEntries(f.formatToParts(now).map(p => [p.type, p.value]));
    return Number(parts.hour) === 14 && Number(parts.minute) === 0;
  }
  
  // Minimal post helper (optionally send JSON body)
  async function post(env: Env, path: string, payload?: unknown) {
    const url = `https://${env.DOMAIN}${path}`;
    const init: RequestInit = {
      method: "POST",
      headers: { "api-key": env.ADMIN_API_KEY },
    };
    if (payload !== undefined) {
      init.headers = new Headers(init.headers);
      (init.headers as Headers).set("content-type", "application/json");
      init.body = JSON.stringify(payload);
    }
    const r = await fetch(url, init);
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`${path} -> ${r.status} ${body.slice(0, 200)}`);
    }
  }
  
  export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
      try {
        switch (event.cron) {
          case "5 5 * * 1": // weekly (~00:05/01:05 ET)
            ctx.waitUntil(post(env, WEEKLY_PATH)); // no body needed
            break;
  
          case "10 5 1 * *": // monthly (~00:10/01:10 ET)
            ctx.waitUntil(post(env, MONTHLY_PATH)); // keep as-is
            break;
  
          case "0 * * * *": // hourly; fire daily batch at 2:00 PM ET
            if (isTwoPmNY()) {
              // ask send.js to respect subscriber weekday cohorts
              ctx.waitUntil(post(env, DAILY_PATH, { respect_day: true }));
            }
            break;
        }
      } catch (e) {
        console.error("cron error:", e);
      }
    },
  };
  