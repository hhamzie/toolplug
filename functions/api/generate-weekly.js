// functions/api/generate-weekly.js
// Secrets: PH_DEV_TOKEN, ADMIN_API_KEY
// Bindings: env.AI (Workers AI), env.DB (D1)
//
// Weekly generator (monthly-email-style per pick):
// - Strict 7-day window (createdAt only)
// - Route posts into 6 buckets
// - Pick top-voted per bucket (tie: newest)
// - For EACH pick, build HTML EXACTLY like preview-monthly's makeBlurb()
// - Insert one queued row per category into essay_queue
// - NO FALLBACK DEFAULTS - all content must be AI-generated


const PH_GQL = "https://api.producthunt.com/v2/api/graphql";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// -------- utils --------
const getWeekNumber = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
};
const getWeekId = (d = new Date()) => `${d.getUTCFullYear()}-W${getWeekNumber(d)}`;


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


// 7-day rolling [start,end) with a small grace
function getRollingWindowBounds(now = new Date(), days = 7, graceMinutes = 15) {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000 + graceMinutes * 60 * 1000);
  return { start, end };
}


// -------- categories --------
const LABELS = {
  dev: "Dev Discoveries",
  design: "Designers Drawer",
  product: "Product Picks",
  ops: "Ops Oasis",
  creators: "Creator's Corner",
  wildcard: "Wildcard Wonders",
};
const LABEL_TO_SLUG = Object.fromEntries(Object.entries(LABELS).map(([slug, label]) => [label, slug]));


const KEYWORDS = {
  "Dev Discoveries": ["developer","dev","cli","terminal","sdk","api","graphql","rest","code","program","library","framework","git","repo","docker","kubernetes","typescript","ide","testing","ci","cd"],
  "Designers Drawer": ["design","designer","ui","ux","figma","wireframe","prototype","mockup","icon","illustration","typography","font","palette","color","layout"],
  "Product Picks": ["productivity","product","notes","docs","wiki","crm","analytics","dashboard","project","tasks","todo","okr","collaboration","team","workflow","roadmap"],
  "Ops Oasis": ["devops","ops","sre","infra","observability","monitoring","logging","traces","alert","oncall","uptime","deploy","pipeline","ci","cd","k8s","serverless","cloud","aws","gcp","azure","security","iam","sso","terraform","helm","backup"],
  "Creator's Corner": ["creator","content","video","shorts","tiktok","reels","youtube","stream","twitch","record","screen","editor","caption","subtitle","thumbnail","audio","music","podcast","photo","photography","luts"],
  "Wildcard Wonders": ["fun","game","entertainment","novelty","random","lifestyle","habit","fitness","travel","finance","budget","health","wellness","misc"],
};
const HINTS = {
  "Dev Discoveries": ["developer","dev","code","api","sdk","cli","terminal","git","ide","framework","library","docker","kubernetes","typescript","database","backend"],
  "Designers Drawer": ["design","ui","ux","figma","prototype","wireframe","mockup","icon","illustration","typography","font","palette","color"],
  "Product Picks": ["productivity","product","notes","docs","wiki","crm","analytics","dashboard","project","tasks","todo","okr","collaboration","team","workflow","roadmap"],
  "Ops Oasis": ["devops","ops","sre","infra","monitor","observability","logging","traces","alert","oncall","uptime","deploy","ci","cd","k8s","serverless","cloud","aws","gcp","azure","security","iam","sso","terraform","helm","backup"],
  "Creator's Corner": ["creator","content","video","tiktok","reels","youtube","stream","twitch","record","editor","caption","subtitle","thumbnail","audio","music","podcast","photo","photography","luts"],
  "Wildcard Wonders": ["fun","games","entertainment","novelty","random","lifestyle","habit","fitness","travel","finance","budget","health","wellness","misc"],
};


// -------- D1 --------
async function ensureDB(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS essay_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT NOT NULL,
      subject    TEXT NOT NULL,
      html       TEXT NOT NULL,
      link       TEXT,
      status     TEXT NOT NULL DEFAULT 'queued',
      week_of    TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_essay_week ON essay_queue(week_of)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_essay_week_cat ON essay_queue(week_of, category)`).run();
}


// -------- PH fetch (<= 3 pages) --------
const GRAPHQL = `
  query Weekly($first: Int!, $after: String, $topicsFirst: Int!) {
    posts(first: $first, order: NEWEST, after: $after) {
      pageInfo { endCursor hasNextPage }
      edges {
        node {
          id
          name
          tagline
          description
          url
          website
          createdAt
          votesCount
          thumbnail { url }
          topics(first: $topicsFirst) { edges { node { slug name } } }
        }
      }
    }
  }
`;


async function fetchPH(env, bounds, pages = 3, first = 30, topicsFirst = 6) {
  const token = (env.PH_DEV_TOKEN || "").trim();
  if (!token) throw new Error("Missing PH_DEV_TOKEN");


  const all = [];
  let after = null;


  for (let i = 0; i < pages; i++) {
    const r = await fetch(PH_GQL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "toolPlug/weekly (+https://toolplug.xyz)"
      },
      body: JSON.stringify({ query: GRAPHQL, variables: { first, after, topicsFirst } }),
    });


    const data = await r.json().catch(() => null);
    const txt = JSON.stringify(data || {});
    if (!r.ok || data?.errors) {
      if (txt.includes("rate_limit_reached")) { await sleep(800); i--; continue; }
      throw new Error(`Product Hunt API (posts) error: ${txt || r.status}`);
    }


    const conn = data?.data?.posts;
    const nodes = (conn?.edges || []).map((e) => e.node);
    all.push(...nodes);


    const last = nodes[nodes.length - 1];
    const lastWhen = last?.createdAt ? new Date(last.createdAt) : null;
    after = conn?.pageInfo?.endCursor || null;


    if (!conn?.pageInfo?.hasNextPage || (lastWhen && lastWhen < bounds.start)) break;
    await sleep(120);
  }


  // keep only items inside [start, end)
  return all.filter((p) => {
    const t = p.createdAt && new Date(p.createdAt);
    return t && t >= bounds.start && t < bounds.end;
  });
}


// -------- routing --------
function scoreLabelByTopics(product, label) {
  const slugs = (product.topics?.edges || []).map((e) => (e.node?.slug || "").toLowerCase());
  const hints = HINTS[label] || [];
  let s = 0;
  for (const slug of slugs) for (const kw of hints) if (slug.includes(kw)) s += 2;
  return s;
}
function scoreLabelByKeywords(product, label) {
  const blob = [product.name, product.tagline, product.description].join(" ").toLowerCase();
  let s = 0; for (const kw of (KEYWORDS[label] || [])) if (blob.includes(kw)) s++;
  return s;
}
function bestLabelFor(product) {
  let best = "Wildcard Wonders", bestScore = -1;
  for (const label of Object.values(LABELS)) {
    const score = scoreLabelByTopics(product, label) + scoreLabelByKeywords(product, label);
    if (score > bestScore) { bestScore = score; best = label; }
  }
  return best;
}
function groupAndPick(posts) {
  const grouped = Object.fromEntries(Object.values(LABELS).map((label) => [label, []]));
  for (const p of posts) grouped[bestLabelFor(p)].push(p);
  const picks = {};
  for (const [label, items] of Object.entries(grouped)) {
    if (!items.length) continue;
    items.sort((a, b) => {
      const v = (Number(b.votesCount) || 0) - (Number(a.votesCount) || 0);
      if (v !== 0) return v;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
    picks[label] = items[0];
  }
  return { grouped, picks };
}
function ensureSixPicks(picks, grouped, allPosts) {
  const have = new Set(Object.keys(picks));
  const need = Object.values(LABELS).filter((label) => !have.has(label));
  if (!need.length) return picks;


  const chosenIds = new Set(Object.values(picks).filter(Boolean).map((p) => p.id));
  const remaining = allPosts
    .filter((p) => !chosenIds.has(p.id))
    .sort((a, b) => {
      const v = (Number(b.votesCount) || 0) - (Number(a.votesCount) || 0);
      if (v !== 0) return v;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });


  for (const label of need) if (remaining.length) picks[label] = remaining.shift();
  return picks;
}


// ---------- EXACT monthly-style blurb builder (NO FALLBACKS) ----------
// This mirrors preview-monthly.js -> makeBlurb(): same subject, same HTML sections & styles.
// NO FALLBACK CONTENT - throws error if AI fails or returns invalid data
async function makeBlurbMonthlyExact(env, product, categoryLabel) {
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


  // NO FALLBACK - strict validation and error throwing
  let data;
  try {
    data = typeof resp === "string" ? JSON.parse(resp) : JSON.parse(resp?.response ?? resp?.output_text ?? "{}");
  } catch (parseErr) {
    throw new Error(`Failed to parse AI response for ${product.name}: ${String(parseErr)}`);
  }

  if (!data.summary || typeof data.summary !== 'string' || data.summary.trim() === '') {
    throw new Error(`Invalid AI response for ${product.name}: missing or empty summary`);
  }
  
  if (!Array.isArray(data.why_bullets) || data.why_bullets.length !== 3 || data.why_bullets.some(b => !b || typeof b !== 'string' || b.trim() === '')) {
    throw new Error(`Invalid AI response for ${product.name}: why_bullets must be array of 3 non-empty strings`);
  }
  
  if (!Array.isArray(data.best_bullets) || data.best_bullets.length !== 3 || data.best_bullets.some(b => !b || typeof b !== 'string' || b.trim() === '')) {
    throw new Error(`Invalid AI response for ${product.name}: best_bullets must be array of 3 non-empty strings`);
  }

  const summary = data.summary.trim();
  const why = data.why_bullets.map(b => b.trim());
  const best = data.best_bullets.map(b => b.trim());


  const categoryPill = `<span style="display:inline-block;margin:8px 0 12px;padding:6px 10px;border-radius:999px;background:#f1f5f9;color:#0f172a;font-size:12px;font-weight:600;">Category: ${categoryLabel}</span>`;

  const html = `
<div style="color:#000;">
  <h2 style="font-size:1.5em;margin-bottom:0.3em;color:#000 !important;">📅 Weekly Product Highlight: ${product.name} 🚀</h2>
  ${categoryPill}
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
  `.replace(/^\s+/gm,"");


  return { subject: `Weekly Product Launch Highlight - ${product.name}`, html, link: site };
}


// -------- core --------
async function generateAndStoreWeek(env) {
  await ensureDB(env);


  // 1) 7-day window & week id
  const now = new Date();
  const { start, end } = getRollingWindowBounds(now, 7, 15);
  const weekId = getWeekId(end);


  // 2) Clear THIS WEEK before inserting (fresh slate)
  await env.DB.prepare(`DELETE FROM essay_queue WHERE week_of = ?`).bind(weekId).run();


  // 3) Fetch posts (<=3 PH requests)
  const posts = await fetchPH(env, { start, end }, 3, 30, 6);


  // 4) Route → pick top per bucket → ensure 6
  const { grouped, picks: initialPicks } = groupAndPick(posts);
  const picks = ensureSixPicks({ ...initialPicks }, grouped, posts);


  // 5) Generate EXACT monthly-style blurbs per pick (up to 6 AI calls)
  // NO FALLBACKS - if any blurb generation fails, the entire process stops
  const results = [];
  for (const [label, product] of Object.entries(picks)) {
    if (!product) continue;
    
     try {
       const { subject, html, link } = await makeBlurbMonthlyExact(env, product, label);

      await env.DB.prepare(`
        INSERT INTO essay_queue (week_of, category, subject, html, link, status)
        VALUES (?, ?, ?, ?, ?, 'queued')
      `).bind(weekId, LABEL_TO_SLUG[label] || "wildcard", subject, html, link).run();

      results.push({ category: LABEL_TO_SLUG[label] || "wildcard", product: product.name, subject, status: "generated" });
      
      // small pause to be gentle on rate limits
      await sleep(80);
    } catch (blurbErr) {
      throw new Error(`Failed to generate blurb for ${label} (${product.name}): ${String(blurbErr)}`);
    }
  }


  const counts = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [LABEL_TO_SLUG[k], v.length]));
  const picksOut = Object.fromEntries(Object.entries(picks).map(([k, p]) => [
    LABEL_TO_SLUG[k],
    p && {
      id: p.id, name: p.name, url: p.url, website: p.website,
      createdAt: p.createdAt, votesCount: p.votesCount,
      topics: (p.topics?.edges || []).map((e) => e.node?.slug).filter(Boolean),
    },
  ]));


  return {
    weekId,
    window: { start: start.toISOString(), end: end.toISOString() },
    counts,
    picks: picksOut,
    results,
  };
}


// -------- HTTP (Pages) --------
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));
  if (request.method !== "POST")   return withCORS(new Response("Method Not Allowed", { status: 405 }));


  const providedKey = request.headers.get("api-key");
  if (!env.ADMIN_API_KEY || providedKey !== env.ADMIN_API_KEY) {
    return withCORS(new Response("Unauthorized", { status: 401 }));
  }
  try {
    return json({ ok: true, ...(await generateAndStoreWeek(env)) });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e), weekId: getWeekId() }, 500);
  }
}