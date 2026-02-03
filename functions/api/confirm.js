// CORS helpers
const CORS_ORIGIN = "*";
const withCORS = (res) => {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", CORS_ORIGIN);
  headers.set("access-control-allow-headers", "content-type, api-key");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers });
};

const normEmail = (e) => String(e || "").toLowerCase().trim();

export async function onRequest(context) {
    const { request, env } = context;
    
    if (request.method !== "GET") {
      return withCORS(new Response("Method Not Allowed", { status: 405 }));
    }
  
    try {
      const url = new URL(request.url);
      const token = url.searchParams.get("token");
      if (!token) return withCORS(new Response("Missing token", { status: 400 }));
  
      const row = await env.DB.prepare(
        "SELECT * FROM subscribers_pending WHERE token = ?"
      ).bind(token).first();
  
      if (!row) return withCORS(new Response("Invalid or expired link", { status: 404 }));
  
      // *** Add this block to check for existing subscriber ***
      const alreadySub = await env.DB.prepare(
        "SELECT 1 FROM subscribers WHERE email = ? LIMIT 1"
      ).bind(normEmail(row.email)).first();
  
      if (alreadySub) {
        // Already subscribed! Show friendly message
        const html = `<!doctype html>
  <meta charset="utf-8">
  <title>Already Subscribed</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; display:grid; place-items:center; min-height:100dvh; margin:0; background:#f8fafc; }
    .card { background:#fff; padding:28px 32px; border-radius:16px; box-shadow:0 6px 24px rgba(0,0,0,.08); max-width:520px; text-align:center; }
    h1 { margin:0 0 10px; font-size:26px; color:#7c3aed;}
    p { margin:8px 0; color:#111827; }
  </style>
  <body>
    <div class="card">
      <h1>You've already subscribed!</h1>
      <p>Wait for the Magic! ✨ Check your inbox soon.</p>
    </div>
  </body>`;
        return withCORS(new Response(html, { headers: { "content-type": "text/html" } }));
      }
      // *** End added block ***
  
      const unsubToken = crypto.randomUUID();
  
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO subscribers (email, send_day, categories, unsub_token) VALUES (?, ?, ?, ?)"
        ).bind(normEmail(row.email), row.send_day, row.categories, unsubToken),
        env.DB.prepare("DELETE FROM subscribers_pending WHERE id = ?").bind(row.id),
      ]);
  
      const html = `<!doctype html>
  <meta charset="utf-8">
  <title>Confirmed</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; display:grid; place-items:center; min-height:100dvh; margin:0; background:#f8fafc; }
    .card { background:#fff; padding:28px 32px; border-radius:16px; box-shadow:0 6px 24px rgba(0,0,0,.08); max-width:520px; text-align:center; }
    h1 { margin:0 0 10px; font-size:26px; color:#7c3aed;}
    p { margin:8px 0; color:#111827; }
  </style>
  <script>
    try { localStorage.setItem('tp_confirmed','1'); } catch (e) {}
  </script>
  <body>
    <div class="card">
      <h1>You're confirmed 🎉</h1>
      <p>You can return to your previous tab — it has been updated.</p>
    </div>
  </body>`;
      return withCORS(new Response(html, { headers: { "content-type": "text/html" } }));
    } catch (e) {
      return withCORS(new Response(e?.message || "Error", { status: 500 }));
    }
  }
  