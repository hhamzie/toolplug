// functions/api/preview-monthly.js
// GET: public preview (cached if available, else rolling 7d with 30d fallback; no email send)
// POST: send preview email to { email } using cached monthly if present, otherwise on-demand
// Env: PH_DEV_TOKEN, AI (Workers AI), DB (D1), BREVO_API_KEY, DOMAIN

const withCORS = (res) => {
    const h = new Headers(res.headers);
    h.set("access-control-allow-origin", "*");
    h.set("access-control-allow-headers", "content-type");
    h.set("access-control-allow-methods", "GET,POST,OPTIONS");
    h.set("vary", "origin");
    return new Response(res.body, { status: res.status, headers: h });
  };
  const json = (obj, status = 200) =>
    withCORS(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
  
  function getMonthId(now = new Date()) {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }
  function rolling30Days(now = new Date(), graceMinutes = 15) {
    const end = new Date(now);
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000 + graceMinutes * 60 * 1000);
    return { start, end };
  }
  function rolling7Days(now = new Date(), graceMinutes = 15) {
    const end = new Date(now);
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000 + graceMinutes * 60 * 1000);
    return { start, end };
  }
  function rolling1Day(now = new Date(), graceMinutes = 15) {
    const end = new Date(now);
    const start = new Date(end.getTime() - 1 * 24 * 60 * 60 * 1000 + graceMinutes * 60 * 1000);
    return { start, end };
  }
  
  // Richer query: include topics + thumbnail for better copy
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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
  async function fetchPHWindow(env, bounds, first = 25, maxPages = 4) {
    const token = (env.PH_DEV_TOKEN || "").trim();
    if (!token) throw new Error("Missing PH_DEV_TOKEN");
  
    const all = [];
    let after = null;
    let page = 0;
    let firstTried = false;
  
    while (page++ < maxPages) {
      if (page > 1) await sleep(200);
  
      const r = await fetch("https://api.producthunt.com/v2/api/graphql", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "toolPlug/preview-monthly (+https://toolplug.xyz)"
        },
        body: JSON.stringify({ query: LIGHT_GRAPHQL, variables: { first, after } })
      });
      const data = await r.json().catch(() => null);
  
      if (!r.ok || data?.errors) {
        const txt = JSON.stringify(data || {});
        const rateLimited = txt.includes("rate_limit_reached");
        if (rateLimited && !firstTried && page === 1) {
          firstTried = true;
          await sleep(1000);
          page--; // retry this page
          continue;
        }
        if (rateLimited) break;
        throw new Error(`Product Hunt API error: ${txt || r.status}`);
      }
  
      const conn = data?.data?.posts;
      const nodes = (conn?.edges || []).map(e => e.node);
      if (!nodes.length) break;
      all.push(...nodes);
  
      const last = nodes[nodes.length - 1];
      const lastWhen = last?.createdAt ? new Date(last.createdAt) : null;
      after = conn?.pageInfo?.endCursor || null;
  
      if (!conn?.pageInfo?.hasNextPage || (lastWhen && lastWhen < bounds.start)) break;
    }
  
    return all.filter(p => {
      const t = p.createdAt && new Date(p.createdAt);
      return t && t >= bounds.start && t < bounds.end;
    });
  }
  
  // --- Formatting helpers ---
  function normalizeHtml(html) {
    if (!html) return "";
    return html
      .replace(/<\/?\d+\s*>/g, "") // remove bogus <2>, </3>, etc.
      .replace(/<>+/g, "")         // remove stray <> or <>> tokens
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  function forceCTAAnchor(html, site, name) {
    if (html.includes("👉")) return html;
    const safe = (site || "").replace(/"/g, "&quot;");
    return html + `\n\n<p>👉 <a href="${safe}" target="_blank" rel="noopener">Try ${name}</a></p>`;
  }
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
  
  // --- Feedback links (👍/👎) ---
  function b64url(s = "") {
    const b = btoa(s);
    return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function makeFeedbackBlock(host, productName, emailOrNull) {
    const base = `https://${host}/api/feedback?src=monthly_preview&pid=${encodeURIComponent(productName)}`;
    const e = emailOrNull ? `&e=${encodeURIComponent(b64url(emailOrNull.toLowerCase()))}` : "";
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
  
  // -- Email content generator (uses concise JSON from AI, then we format HTML) --
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
  
    let summary = "A fresh, useful tool! 🚀";
    let why = ["Fast and fun to use! 🎉", "Looks great on any device 😎", "Beloved by the community 🤩"];
    let best = ["Busy creators 🛠️", "Collaboration lovers 👥", "Productivity fans 💡"];
    try {
      let data = typeof resp === "string" ? JSON.parse(resp) : JSON.parse(resp?.response ?? resp?.output_text ?? "{}");
      if (data.summary) summary = data.summary;
      if (Array.isArray(data.why_bullets) && data.why_bullets.length === 3) why = data.why_bullets;
      if (Array.isArray(data.best_bullets) && data.best_bullets.length === 3) best = data.best_bullets;
    } catch { /* fallback above */ }
  
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
  `.replace(/^\s+/gm,"");
  
    return { subject: `Daily Launch Favorite - ${product.name}`, html, link: site };
  }
  
  // --- DB/cache + email helpers ---
  async function readCached(env, monthId) {
    try {
      return await env.DB.prepare(
        "SELECT subject, html, link, product_name, month_of, created_at FROM monthly_preview WHERE month_of = ? ORDER BY id DESC LIMIT 1"
      ).bind(monthId).first();
    } catch { return null; }
  }
  function basicFooter(host, unsubToken) {
    const unsubUrl = unsubToken ? `https://${host}/api/unsubscribe?token=${encodeURIComponent(unsubToken)}` : null;
    return `
      <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
      <p style="font-size:12px;color:#666">
        You're receiving this because you subscribed to ToolPlug.
        ${unsubUrl ? `<br><a href="${unsubUrl}">Unsubscribe</a>` : ""}
      </p>
    `.trim();
  }
  async function sendEmail(env, to, subject, html) {
    const host = env.DOMAIN || "toolplug.xyz";
    const emailResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        sender:  { email: `hello@${host}`, name: "ToolPlug" },
        replyTo: { email: `hello@${host}`, name: "ToolPlug" },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      }),
    });
    if (!emailResponse.ok) {
      const errTxt = await emailResponse.text().catch(() => String(emailResponse.status));
      throw new Error("Brevo send failed: " + errTxt);
    }
  }
  
  // --- Router/entrypoint ---
  export async function onRequest(context) {
    const { request, env } = context;
    if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));
  
    if (request.method === "GET") {
      try {
        const now = new Date();
        const monthId = getMonthId(now);
  
        const row = await readCached(env, monthId);
        if (row) {
          const fixedHtml = forceCTAAnchor(normalizeHtml(row.html), row.link, row.product_name);
          return json({
            ok: true,
            source: "cached",
            month_of: row.month_of,
            subject: row.subject,
            html: fixedHtml,
            link: row.link,
            product: row.product_name,
          });
        }
  
        // On-demand: today's launches (24h), then 7d, then 30d as fallback
        let bounds = rolling1Day(now, 15);
        let posts = await fetchPHWindow(env, bounds, 25, 4);
        if (!posts.length) {
          bounds = rolling7Days(now, 15);
          posts = await fetchPHWindow(env, bounds, 25, 4);
        }
        if (!posts.length) {
          bounds = rolling30Days(now, 15);
          posts = await fetchPHWindow(env, bounds, 25, 8);
        }
        if (!posts.length) return json({ ok: false, error: "No recent posts to preview" }, 404);
  
        posts.sort((a, b) =>
          ((Number(b.votesCount) || 0) - (Number(a.votesCount) || 0)) ||
          (new Date(b.createdAt) - new Date(a.createdAt))
        );
        const top = posts[0];
        const { subject, html, link } = await makeBlurb(env, top);
  
        return json({ ok: true, source: "on-demand", month_of: monthId, subject, html, link, product: top.name });
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }
  
    if (request.method === "POST") {
      try {
        const { email } = await request.json().catch(() => ({}));
        const to = String(email || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
          return json({ ok: false, error: "Invalid email" }, 400);
        }
  
        const now = new Date();
        const monthId = getMonthId(now);
        const host = env.DOMAIN || "toolplug.xyz";
  
        let row = await readCached(env, monthId);
        let subject, html, link, productName;
  
        if (row) {
          subject = row.subject;
          link = row.link;
          productName = row.product_name || "this pick";
          html = forceCTAAnchor(normalizeHtml(row.html), link, productName);
        } else {
          // On-demand: today -> 7d -> 30d
          let bounds = rolling1Day(now, 15);
          let posts = await fetchPHWindow(env, bounds, 25, 4);
          if (!posts.length) {
            bounds = rolling7Days(now, 15);
            posts = await fetchPHWindow(env, bounds, 25, 4);
          }
          if (!posts.length) {
            bounds = rolling30Days(now, 15);
            posts = await fetchPHWindow(env, bounds, 25, 8);
          }
          if (!posts.length) return json({ ok: false, error: "No recent posts to preview" }, 404);
  
          posts.sort((a, b) =>
            ((Number(b.votesCount) || 0) - (Number(a.votesCount) || 0)) ||
            (new Date(b.createdAt) - new Date(a.createdAt))
          );
          const top = posts[0];
          const out = await makeBlurb(env, top);
          subject = out.subject;
          html = out.html;
          link = out.link;
          productName = top.name;
        }
  
        // Inject feedback buttons before footer
        html += makeFeedbackBlock(host, productName, to);
  
        // Footer (no unsub for sample)
        html += basicFooter(host, null);
  
        await sendEmail(env, to, subject, html);
        return json({ ok: true, sent_to: to, source: row ? "cached" : "on-demand" });
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }
  
    return withCORS(new Response("Method Not Allowed", { status: 405 }));
  }
  