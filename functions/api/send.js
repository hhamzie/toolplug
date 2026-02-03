// functions/api/send.js

// --- CORS helpers ---
const CORS_ORIGIN = "*";
const withCORS = (res) => {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", CORS_ORIGIN);
  headers.set("access-control-allow-headers", "content-type, api-key");
  headers.set("access-control-allow-methods", "POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers });
};
const json = (obj, status = 200) =>
  withCORS(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));

// --- time + week helpers (match generate-weekly) ---
const getWeekNumber = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
};
const getWeekId = (d = new Date()) => `${d.getUTCFullYear()}-W${getWeekNumber(d)}`;

function nyNow() {
  const d = new Date();
  return new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function nyDow() {
  return nyNow().getDay(); // 0..6 (Sun..Sat) in America/New_York
}
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- DB bootstrap for idempotency ---
async function ensureSendLog(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email  TEXT NOT NULL,
      week_of TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_send_unique ON send_log(email, week_of)`).run();
}

// --- feedback helpers (match monthly style) ---
function b64url(s = "") {
  const b = btoa(s);
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function makeFeedbackBlock(host, productName, emailOrNull) {
  const base = `https://${host}/api/feedback?src=weekly&pid=${encodeURIComponent(productName)}`;
  const e = emailOrNull ? `&e=${encodeURIComponent(b64url(String(emailOrNull).toLowerCase()))}` : "";
  const up = `${base}&v=up${e}`;
  const dn = `${base}&v=down${e}`;
  return `
<div style="margin-top:18px;padding:12px 14px;border:1px solid #eee;border-radius:12px">
  <div style="font-weight:600;margin-bottom:8px">Did you enjoy this article?</div>
  <div>
    <a href="${up}" style="display:inline-block;margin-right:10px;padding:.5rem .8rem;border-radius:10px;background:#16a34a;color:#fff;text-decoration:none">👍 Loved it</a>
    <a href="${dn}" style="display:inline-block;padding:.5rem .8rem;border-radius:10px;background:#ef4444;color:#fff;text-decoration:none">👎 Needs work</a>
  </div>
  <div style="margin-top:8px;font-size:12px;color:#666">Tap to vote—then leave an optional note.</div>
</div>
`.replace(/^\s+/gm, "");
}
// Try to extract product name from weekly subject like: "Weekly Favorite — NAME (Category)"
function extractProductFromSubject(subj = "") {
  const m = subj.match(/Weekly Favorite\s*—\s*(.+?)\s*\(/);
  return (m && m[1]) ? m[1].trim() : subj.trim();
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));
  if (request.method !== "POST")    return withCORS(new Response("Method Not Allowed", { status: 405 }));

  // --- auth (matches cron Worker header) ---
  const providedKey = request.headers.get("api-key");
  if (!env.ADMIN_API_KEY || providedKey !== env.ADMIN_API_KEY) {
    return withCORS(new Response("Unauthorized", { status: 401 }));
  }

  try {
    await ensureSendLog(env);

    // Support both JSON body and query param. Default to respecting the weekday.
    const url = new URL(request.url);
    const qpRespect = url.searchParams.get("respect_day");
    const body = await request.json().catch(() => ({}));
    const respectDay =
      qpRespect != null
        ? qpRespect === "1" || qpRespect === "true"
        : (Object.prototype.hasOwnProperty.call(body, "respect_day") ? !!body.respect_day : true);

    const weekId = String(body?.week_id || getWeekId()); // default current ISO week

    // --- fetch THIS WEEK's essays (queued) ---
    const essaysResult = await env.DB
      .prepare("SELECT id, category, subject, html, link FROM essay_queue WHERE week_of = ? AND status = 'queued'")
      .bind(weekId)
      .all();
    const essays = Array.isArray(essaysResult?.results) ? essaysResult.results : [];
    if (!essays.length) return json({ ok: false, message: "No queued essays for this week", weekId });

    // --- fetch subscribers (optionally filter by their chosen weekday) ---
    let subSql = "SELECT email, unsub_token, send_day, categories FROM subscribers";
    const subBinds = [];
    if (respectDay) {
      subSql += " WHERE send_day = ?";
      subBinds.push(String(nyDow())); // NY weekday 0..6
    }
    const subResult = await env.DB.prepare(subSql).bind(...subBinds).all();
    const subscribers = Array.isArray(subResult?.results) ? subResult.results : [];
    if (!subscribers.length) return json({ ok: true, weekId, sent: 0, note: "No matching subscribers" });

    // --- hostname / domain + error bucket ---
    const hostname = (() => {
      try { return new URL(request.url).hostname; } catch { return "toolplug.xyz"; }
    })();
    const domain = env.DOMAIN || hostname || "toolplug.xyz";
    const errors = [];

    let sent = 0, failed = 0, skippedAlreadySent = 0, skippedNoMatch = 0;

    for (const sub of subscribers) {
      try {
        // 1× per person per week guard
        const prior = await env.DB
          .prepare("SELECT 1 FROM send_log WHERE email = ? AND week_of = ? LIMIT 1")
          .bind(String(sub.email || "").toLowerCase(), weekId)
          .first();
        if (prior) { skippedAlreadySent++; continue; }

        // subscriber category prefs
        const cats = String(sub.categories || "")
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);
        if (!cats.length) { skippedNoMatch++; continue; }

        // Build per-category matches (ensures: one email, and if 1 category it's deterministic)
        const byCategory = cats
          .map(cat => essays.find(es => String(es.category || "").toLowerCase() === cat))
          .filter(Boolean);

        if (!byCategory.length) { skippedNoMatch++; continue; }

        // If user has exactly 1 category → always that. If >1 → random among their matched categories.
        const pick = byCategory.length === 1
          ? byCategory[0]
          : byCategory[Math.floor(Math.random() * byCategory.length)];

        const unsubUrl = `https://${hostname}/api/unsubscribe?token=${encodeURIComponent(sub.unsub_token || "")}`;
        const productName = extractProductFromSubject(pick.subject || "this pick");
        const feedback = makeFeedbackBlock(hostname, productName, sub.email);

        const htmlContent =
          String(pick.html || "") +
          feedback +
          `<hr style="margin:24px 0;border:none;border-top:1px solid #eee">` +
          `<p style="font-size:12px;color:#666">You're receiving this because you subscribed to ToolPlug.<br>` +
          `<a href="${unsubUrl}">Unsubscribe</a></p>`;

        const textContent = htmlToText(htmlContent);

        const emailResp = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({
            sender:  { email: `hello@${domain}`, name: "ToolPlug" },
            replyTo: { email: `hello@${domain}`, name: "ToolPlug" },
            to: [{ email: sub.email }],
            subject: pick.subject,
            textContent,
            htmlContent,
          }),
        });

        if (!emailResp.ok) {
          const body = await emailResp.text().catch(() => "");
          errors.push({ email: sub.email, status: emailResp.status, body: body.slice(0, 300) });
          failed++;
          continue;
        }

        // Record success (prevents multiple sends this ISO week)
        await env.DB
          .prepare("INSERT OR IGNORE INTO send_log (email, week_of) VALUES (?, ?)")
          .bind(String(sub.email || "").toLowerCase(), weekId)
          .run();

        sent++;
      } catch (err) {
        errors.push({ email: sub?.email || "unknown", status: "client-catch", body: String(err?.message || err).slice(0, 300) });
        failed++;
      }
    }

    return json({
      ok: true,
      weekId,
      totalSubscribers: subscribers.length,
      sent,
      failed,
      skippedAlreadySent,
      skippedNoMatch,
      ...(errors.length ? { errors } : {})
    });
  } catch (e) {
    return withCORS(new Response(e?.message || "Error", { status: 500 }));
  }
}
