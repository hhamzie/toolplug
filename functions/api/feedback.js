// functions/api/feedback.js
// Records simple email feedback (👍/👎) and optional comment to D1,
// and ALWAYS shows a human "thanks" page.
// GET  /api/feedback?v=up|down&src=monthly_preview&pid=<product>&e=<base64url email>
// POST /api/feedback (form submit: src, pid, v, e, comment)
//
// Env: DB (D1)

const HTML = (body) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Thanks for your feedback</title>
  <style>
    :root { color-scheme: light dark; }
    body{
      margin:0;
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;
      background: linear-gradient(135deg,#fefefe 0%,#f8f9ff 50%,#f0f4ff 100%);
      color:#4A5568;
      -webkit-font-smoothing: antialiased;
    }
    *, *::before, *::after { box-sizing: border-box; }
    .wrap{ min-height:100dvh; display:grid; place-items:center; padding:24px; }
    .card{
      width:100%; max-width:720px;
      background: rgba(255,255,255,.95);
      border:1px solid rgba(155,107,158,.25);
      border-radius:16px;
      box-shadow:0 12px 24px rgba(155,107,158,.15);
      backdrop-filter: blur(10px);
      padding:24px;
    }
    h1{ margin:0 0 10px; font-size:24px; color:#9B6B9E; font-weight:700; }
    p.lead{ margin:6px 0 16px; color:#6B7280; }
    textarea{ width:100%; max-width:100%; display:block; padding:12px 14px; border-radius:10px; border:2px solid rgba(155,107,158,.12); outline:none; background:#fff; color:#4A5568; box-sizing:border-box; }
    textarea:focus{ border-color:#9B6B9E; box-shadow:0 0 0 3px rgba(155,107,158,.25); }
    .actions{ margin-top:12px; display:flex; gap:12px; flex-wrap:wrap; }
    .btn{ display:inline-flex; align-items:center; justify-content:center; padding:10px 16px; border-radius:10px; font-weight:600; text-decoration:none; cursor:pointer; transition:transform .15s ease; }
    .btn:active{ transform:translateY(0); }
    .btn-primary{ background:#9B6B9E; color:#fff; box-shadow:0 4px 12px rgba(155,107,158,.25); border:none; }
    .btn-primary:hover{ background:#E8A5C5; }
    .btn-outline{ background:transparent; color:#4A5568; border:2px solid rgba(155,107,158,.25); }
    .btn-outline:hover{ color:#9B6B9E; border-color:#9B6B9E; background:rgba(155,107,158,.05); }
    .footer{ margin-top:20px; font-size:12px; color:#6B7280; text-align:center; }
  </style>
  <div class="wrap"><div class="card">
    ${body}
    <p class="footer">ToolPlug • Thanks for helping us improve 💜</p>
  </div></div>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
      },
    }
  );
  
  async function ensureDB(env) {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        src TEXT,
        product TEXT,
        vote TEXT,          -- 'up' | 'down' | NULL
        comment TEXT,       -- optional
        email_b64 TEXT,     -- base64url of email if provided
        email_hash TEXT,    -- sha256(lowercase email)
        ua TEXT,
        ip TEXT
      )
    `).run();
  }
  
  function escapeHtml(s = "") {
    return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function b64urlDecode(s = "") {
    try {
      s = s.replace(/-/g, "+").replace(/_/g, "/");
      const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
      return atob(s + "=".repeat(pad));
    } catch {
      return "";
    }
  }
  const enc = new TextEncoder();
  async function sha256hex(s) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function clientIp(request) {
    return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  }
  
  function thanksBody({ vote, src, pid, e }) {
    const headline =
      vote === "up"
        ? "👍 Thanks — noted!"
        : vote === "down"
        ? "👎 Thanks — we’ll improve!"
        : "Thanks for your feedback!";
    return `
      <h1>${headline}</h1>
      <p class="lead">Optional: a quick note helps us tune the newsletter.</p>

      <form method="POST" action="/api/feedback" style="margin-top:8px">
        <input type="hidden" name="src" value="${escapeHtml(src || "unknown")}">
        <input type="hidden" name="pid" value="${escapeHtml(pid || "")}">
        <input type="hidden" name="v"   value="${escapeHtml(vote || "")}">
        <input type="hidden" name="e"   value="${escapeHtml(e || "")}">

        <textarea name="comment" rows="5" placeholder="What should we change or improve? (optional)"></textarea>

        <div class="actions">
          <button type="submit" class="btn btn-primary">Send feedback</button>
          <a href="/" class="btn btn-outline">Close</a>
        </div>
      </form>
    `.replace(/^\s+/gm, "");
  }
  
  export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    await ensureDB(env);
  
    if (request.method === "GET") {
      // Read vote if present; otherwise treat as generic feedback click.
      const vote = (url.searchParams.get("v") || "").toLowerCase(); // 'up'|'down' or empty
      const src = url.searchParams.get("src") || "unknown";
      const pid = url.searchParams.get("pid") || "";
      const e = url.searchParams.get("e") || ""; // base64url(email) optional
  
      const ua = request.headers.get("user-agent") || "";
      const ip = clientIp(request);
  
      // Derive hash if email provided
      let emailHash = null;
      if (e) {
        const email = b64urlDecode(e).trim().toLowerCase();
        if (email) emailHash = await sha256hex(email);
      }
  
      // Record the click (vote can be null if missing/invalid)
      try {
        await env.DB.prepare(
          `INSERT INTO feedback_events (src, product, vote, email_b64, email_hash, ua, ip)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(src, pid, vote === "up" || vote === "down" ? vote : null, e || null, emailHash, ua, ip)
          .run();
      } catch {
        // swallow errors to keep UX smooth
      }
  
      // ALWAYS render a thanks page (no JSON error)
      return HTML(thanksBody({ vote, src, pid, e }));
    }
  
    if (request.method === "POST") {
      // Accept form-encoded or JSON; store optional comment.
      const ctype = request.headers.get("content-type") || "";
      let src = "",
        pid = "",
        v = "",
        e = "",
        comment = "";
      if (ctype.includes("application/json")) {
        const body = await request.json().catch(() => ({}));
        src = body.src || "";
        pid = body.pid || "";
        v = (body.v || "").toLowerCase();
        e = body.e || "";
        comment = body.comment || "";
      } else {
        const form = await request.formData();
        src = form.get("src") || "";
        pid = form.get("pid") || "";
        v = (form.get("v") || "").toString().toLowerCase();
        e = form.get("e") || "";
        comment = form.get("comment") || "";
      }
  
      const ua = request.headers.get("user-agent") || "";
      const ip = clientIp(request);
  
      let emailHash = null;
      if (e) {
        const email = b64urlDecode(e).trim().toLowerCase();
        if (email) emailHash = await sha256hex(email);
      }
  
      try {
        await env.DB.prepare(
          `INSERT INTO feedback_events (src, product, vote, comment, email_b64, email_hash, ua, ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(src || "unknown", pid || "", v === "up" || v === "down" ? v : null, comment || null, e || null, emailHash, ua, ip)
          .run();
      } catch {
        // swallow
      }
  
      // Show a final thanks page
      return HTML(
        `<h1>🙏 Thanks for the feedback!</h1>
         <p class="lead">We read every note. You can close this tab.</p>`
      );
    }
  
    return new Response("Method Not Allowed", { status: 405 });
  }
  