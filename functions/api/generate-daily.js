// functions/api/generate-daily.js
// Secrets: PH_DEV_TOKEN, ADMIN_API_KEY
// Bindings: env.AI (Workers AI), env.DB (D1)

const withCORS = (res) => {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type, api-key");
  h.set("access-control-allow-methods", "POST,OPTIONS");
  h.set("vary", "origin");
  return new Response(res.body, { status: res.status, headers: h });
};

const json = (obj, status = 200) =>
  withCORS(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));

// Previous 24 hours bounds in UTC
function getPrev24HoursBounds(now = new Date()) {
  const end = new Date(now);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

// Day id for the “issue day” (like "2025-09-01")
function getDayId(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

async function ensureDB(env) {
  await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monthly_preview (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day_of TEXT NOT NULL,
        subject TEXT NOT NULL,
        html TEXT NOT NULL,
        link TEXT,
        product_name TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
}

// Include thumbnail + topics for richer copy
const LIGHT_GRAPHQL = `
    query Light($first:Int!,$after:String){
      posts(first:$first, order: NEWEST, after:$after){
        pageInfo{ endCursor hasNextPage }
        edges{ node{
          id name tagline description url website createdAt votesCount
          thumbnail { url }
          topics(first: 6) { edges { node { slug name } } }
        }}
      }
    }
  `;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPHInRange(env, start, end, pages = 6, first = 25) {
  const token = (env.PH_DEV_TOKEN || "").trim();
  if (!token) throw new Error("Missing PH_DEV_TOKEN");

  const all = [];
  let after = null;

  for (let i = 0; i < pages; i++) {
    // Small delay between pages to be gentle on PH
    if (i > 0) await sleep(200);

    const r = await fetch("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "toolPlug/daily (+https://toolplug.xyz)"
      },
      body: JSON.stringify({ query: LIGHT_GRAPHQL, variables: { first, after } })
    });

    const data = await r.json().catch(() => null);

    // Handle rate limits gracefully
    if (!r.ok || data?.errors) {
      const errTxt = JSON.stringify(data);
      if (errTxt && errTxt.includes("rate_limit_reached")) {
        const reset = Number(
          data?.errors?.[0]?.details?.reset_in ?? 0
        );
        const waitMs = Math.min(30000, Math.max(0, reset * 1000));
        if (waitMs) await sleep(waitMs);
        // Stop paging; we'll return what we have (or let caller fall back to cache)
        break;
      }
      throw new Error(`Product Hunt API error: ${errTxt || r.status}`);
    }

    const conn = data?.data?.posts;
    const nodes = (conn?.edges || []).map((e) => e.node);
    all.push(...nodes);

    const last = nodes[nodes.length - 1];
    const lastWhen = last?.createdAt ? new Date(last.createdAt) : null;
    after = conn?.pageInfo?.endCursor || null;

    if (!conn?.pageInfo?.hasNextPage || (lastWhen && lastWhen < start)) break;
  }

  return all.filter((p) => {
    const t = p.createdAt && new Date(p.createdAt);
    return t && t >= start && t < end;
  });
}

// ---------- richer copy: relevant emojis + specific bullets ----------
function pickEmojis(product) {
  const blob = [
    product.name, product.tagline, product.description,
    ...(product.topics?.edges || []).map(e => e?.node?.slug || e?.node?.name || "")
  ].join(" ").toLowerCase();

  const rules = [
    [/terminal|cli|shell|bash|zsh|warp/, ["🧑‍💻","⌨️","🖥️"]],
    [/developer|code|sdk|api|framework|typescript|rust|go|python/, ["🧑‍💻","🛠️","📦"]],
    [/design|figma|ui|ux|prototype|mockup/, ["🎨","🧩","✨"]],
    [/video|editor|caption|reels|tiktok|youtube/, ["🎬","✂️","📺"]],
    [/audio|music|podcast/, ["🎧","🎵"]],
    [/photo|image|thumbnail|camera/, ["📸","🖼️"]],
    [/project|tasks|todo|workflow|kanban|team/, ["📋","✅","🗂️"]],
    [/analytics|dashboard|metrics|insight/, ["📊","📈"]],
    [/security|auth|iam|sso/, ["🔒","🛡️"]],
    [/cloud|serverless|kubernetes|aws|gcp|azure/, ["☁️","⚙️"]],
    [/ai|assistant|gpt|llm|prompt/, ["🤖","🧠"]],
    [/speed|fast|performance/, ["💨"]],
    [/collaborat|share|team/, ["👥"]],
  ];

  const out = new Set();
  for (const [re, emojis] of rules) if (re.test(blob)) emojis.forEach(e => out.add(e));
  if (!out.size) ["✨","⭐","🚀"].forEach(e => out.add(e));
  return Array.from(out).slice(0, 6);
}

/**
 * FIX (minimal): makeBlurb now matches preview-daily / generate-weekly format:
 * AI returns JSON -> we render consistent HTML (no "Concrete capability" placeholders).
 */
async function makeBlurb(env, product) {
  const site = product.website || product.url || "";

  const logo = (product.thumbnail && product.thumbnail.url)
    ? `<img src="${product.thumbnail.url}" alt="${product.name} logo" width="72" height="72" style="display:block;margin-bottom:18px;border-radius:14px;">`
    : "";

  const sys = `You help write newsletter blurbs for new tech products.
Output as raw JSON with exactly three fields only:
{
  "summary": "<your 1-2 sentence summary of the product, must include at least one emoji, and must be simple but brief.>",
  "why_bullets": ["...","...","..."],    // 3 bullets, all energetic w/ emojis, each ≤ 13 words
  "best_bullets": ["...","...","..."]    // 3 bullets, each with at least one emoji
}
No prose, no markdown, no commentary—just the JSON.`;

  const user = `
Product: ${product.name}
Tagline: ${product.tagline || ""}
Description: ${product.description || ""}
Site: ${site}
  `.trim();

  const resp = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      max_tokens: 400,
      temperature: 0.35
    }
  );

  // Minimal but safer defaults (kept non-placeholder-ish)
  let summary = `${product.tagline || "A fresh Product Hunt launch."} 🚀`;
  let why = ["Useful out of the box ✨", "Focused workflow improvements ✅", "Simple setup 🛠️"];
  let best = ["Solo builders 🧑‍💻", "Small teams 👥", "Anyone trying new tools 🚀"];

  try {
    const data = typeof resp === "string"
      ? JSON.parse(resp)
      : JSON.parse(resp?.response ?? resp?.output_text ?? "{}");

    if (data.summary && String(data.summary).trim()) summary = String(data.summary).trim();

    if (Array.isArray(data.why_bullets) && data.why_bullets.length === 3) {
      const cleaned = data.why_bullets.map((b) => String(b).trim()).filter(Boolean);
      if (cleaned.length === 3) why = cleaned;
    }

    if (Array.isArray(data.best_bullets) && data.best_bullets.length === 3) {
      const cleaned = data.best_bullets.map((b) => String(b).trim()).filter(Boolean);
      if (cleaned.length === 3) best = cleaned;
    }
  } catch {
    // keep defaults
  }

  const html = `
<div style="color:#000;">
  <h2 style="font-size:1.5em;margin-bottom:0.3em;color:#000 !important;">📅 Daily Favorite: ${product.name} 🚀</h2>
  ${logo}
  <h3 style="margin-bottom:0.4em;color:#000 !important;">What is it?</h3>
  <p style="font-size:1.05em;margin-top:0;margin-bottom:1.1em;color:#000 !important;">${summary}</p>
  <h3 style="margin-bottom:0.4em;color:#000 !important;">Why you'll love it:</h3>
  <ul style="margin-top:0.1em;margin-bottom:1.1em;color:#000 !important;">
    <li style="color:#000 !important;">${why[0]}</li>
    <li style="color:#000 !important;">${why[1]}</li>
    <li style="color:#000 !important;">${why[2]}</li>
  </ul>
  <h3 style="margin-bottom:0.4em;color:#000 !important;">Best for:</h3>
  <ul style="margin-top:0.1em;margin-bottom:1.1em;color:#000 !important;">
    <li style="color:#000 !important;">${best[0]}</li>
    <li style="color:#000 !important;">${best[1]}</li>
    <li style="color:#000 !important;">${best[2]}</li>
  </ul>
  <p style="margin-top:1.2em;">
    👉 <a href="${site}" target="_blank" style="font-weight:bold;text-decoration:none;color:#3366cc;">Try ${product.name}</a>
  </p>
</div>
`.replace(/^\s+/gm, "");

  return { subject: `Daily Launch Favorite - ${product.name}`, html, link: site };
}

async function readCachedDaily(env, dayId) {
  try {
    return await env.DB.prepare(
      "SELECT subject, html, link, product_name, day_of, created_at FROM monthly_preview WHERE day_of = ? ORDER BY id DESC LIMIT 1"
    ).bind(dayId).first();
  } catch {
    return null;
  }
}

async function generateDay(env, { force = false } = {}) {
  await ensureDB(env);

  const now = new Date();
  const dayId = getDayId(now);
  const cache = await readCachedDaily(env, dayId);

  // If we already have this day's preview and not forcing, reuse it
  if (cache && !force) {
    return {
      source: "cached",
      dayId,
      window: null,
      result: { product: cache.product_name, subject: cache.subject, link: cache.link }
    };
  }

  const { start, end } = getPrev24HoursBounds(now);

  // Pull posts, but be gentle on PH (reduced pages + delay)
  let posts = [];
  try {
    posts = await fetchPHInRange(env, start, end, 6, 25);
  } catch (e) {
    // If we hit PH issues and we have a cache, keep serving the cache
    if (cache) {
      return {
        source: "cached",
        dayId,
        window: { start: start.toISOString(), end: end.toISOString() },
        result: { product: cache.product_name, subject: cache.subject, link: cache.link },
        note: "PH error; served cached daily"
      };
    }
    // No cache to fallback to -> bubble up
    throw e;
  }

  if (!posts.length) {
    // No posts found; fall back to cache if present
    if (cache) {
      return {
        source: "cached",
        dayId,
        window: { start: start.toISOString(), end: end.toISOString() },
        result: { product: cache.product_name, subject: cache.subject, link: cache.link },
        note: "No posts last 24h; served cached daily"
      };
    }
    return {
      source: "empty",
      dayId,
      window: { start: start.toISOString(), end: end.toISOString() },
      result: null,
      note: "No posts last 24h"
    };
  }

  posts.sort((a, b) =>
    ((Number(b.votesCount) || 0) - (Number(a.votesCount) || 0)) ||
    ((new Date(b.createdAt)).getTime() - (new Date(a.createdAt)).getTime())
  );
  const top = posts[0];

  const { subject, html, link } = await makeBlurb(env, top);

  // Only now replace the cache (avoid wiping on failures)
  await env.DB.prepare(`DELETE FROM monthly_preview WHERE day_of = ?`).bind(dayId).run();
  await env.DB.prepare(`
      INSERT INTO monthly_preview (day_of, subject, html, link, product_name)
      VALUES (?, ?, ?, ?, ?)
    `).bind(dayId, subject, html, link, top.name).run();

  return {
    source: "fresh",
    dayId,
    window: { start: start.toISOString(), end: end.toISOString() },
    result: { product: top.name, subject, link }
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));
  if (request.method !== "POST") return withCORS(new Response("Method Not Allowed", { status: 405 }));

  // Require the same header your Worker is sending
  const providedKey = request.headers.get("api-key");
  if (!env.ADMIN_API_KEY || providedKey !== env.ADMIN_API_KEY) {
    return withCORS(new Response("Unauthorized", { status: 401 }));
  }

  // Optional: support ?force=1 to rebuild even if cached
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  try {
    const out = await generateDay(env, { force });
    return json({ ok: true, ...out });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}

// Note: onScheduled won't run on Pages; your cron Worker calls this route.
export async function onScheduled(event, env, ctx) {
  try { console.log("daily cron:", await generateDay(env)); }
  catch (err) { console.error("daily cron error:", err); }
}
