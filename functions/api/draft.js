// CORS helpers
const CORS_ORIGIN = "*";
const withCORS = (res) => {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", CORS_ORIGIN);
  headers.set("access-control-allow-headers", "content-type, api-key");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers });
};
const json = (obj, status = 200) =>
  withCORS(new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  }));

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method === "OPTIONS") {
    return withCORS(new Response(null, { status: 204 }));
  }
  
  if (request.method !== "POST") {
    return withCORS(new Response("Method Not Allowed", { status: 405 }));
  }
  
  try {
    const body = await request.json().catch(() => ({}));
    const category = String(body?.category || "").trim().toLowerCase();
    if (!category) return withCORS(new Response("Missing category", { status: 400 }));

    // Ensure table exists (safe if already created)
    try {
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS essay_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        html TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        week_of TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_eq_status ON essay_queue(status);
      CREATE INDEX IF NOT EXISTS idx_eq_category ON essay_queue(category);`);
    } catch {}

    const model = "@cf/meta/llama-3.1-8b-instruct-fp8";
    const messages = [
      { role: "system", content: "You write short, punchy weekly emails about one software tool. Output strict JSON with keys: subject, html." },
      { role: "user", content:
`Category: ${category}

Write a single-tool newsletter email.
Constraints:
- 1 clear subject line (<= 70 chars)
- HTML body only (no external CSS), use <h2>, <p>, <ul>, <li>, <a>
- Include exactly 1 featured tool with a real-looking link (placeholder ok)
- Tone: brief, useful, friendly
Return STRICT JSON: {"subject":"...","html":"..."}` }
    ];

    const ai = await env.AI.run(model, { messages, max_tokens: 800 });
    const raw = (typeof ai === "string")
      ? ai
      : (ai?.response ?? ai?.output_text ?? JSON.stringify(ai));

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const m = String(raw).match(/\{[\s\S]*\}/);
      data = m ? JSON.parse(m[0]) : null;
    }
    if (!data || !data.subject || !data.html) {
      return withCORS(new Response("Model returned unexpected format", { status: 502 }));
    }

    const subject = String(data.subject).slice(0, 120).trim() || "Weekly pick";
    const html = String(data.html).trim();

    const ins = await env.DB.prepare(
      "INSERT INTO essay_queue (category, subject, html, status) VALUES (?, ?, ?, 'queued')"
    ).bind(category, subject, html).run();

    const previewHtml = html.substring(0, 280);
    return json({ ok: true, id: ins.lastRowId, subject, previewHtml });
  } catch (e) {
    return withCORS(new Response(e?.message || "Error", { status: 500 }));
  }
}
