// GET /api/list-week?week=YYYY-W##&include_html=1
// Auth: header `api-key: <ADMIN_API_KEY>`
const withCORS = (res) => {
    const h = new Headers(res.headers);
    h.set("access-control-allow-origin", "*");
    h.set("access-control-allow-headers", "content-type, api-key");
    h.set("access-control-allow-methods", "GET,OPTIONS");
    return new Response(res.body, { status: res.status, headers: h });
  };
  const json = (obj, status = 200) =>
    withCORS(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
  
  const LABELS = {
    dev: "Dev Discoveries",
    design: "Designers Drawer",
    product: "Product Picks",
    ops: "Ops Oasis",
    creators: "Creator's Corner",
    wildcard: "Wildcard Wonders",
  };
  const ORDER = "CASE category " +
    "WHEN 'dev' THEN 0 WHEN 'design' THEN 1 WHEN 'product' THEN 2 " +
    "WHEN 'ops' THEN 3 WHEN 'creators' THEN 4 WHEN 'wildcard' THEN 5 ELSE 9 END";
  
  const getWeekNumber = (date) => {
    const d = new Date(date);
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1)/86400000 - 3 + (week1.getDay() + 6) % 7)/7);
  };
  
  export async function onRequest({ request, env }) {
    if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));
    if (request.method !== "GET") return withCORS(new Response("Method Not Allowed", { status: 405 }));
  
    if (request.headers.get("api-key") !== env.ADMIN_API_KEY)
      return withCORS(new Response("Unauthorized", { status: 401 }));
  
    const url = new URL(request.url);
    let week = url.searchParams.get("week");
    const includeHTML = url.searchParams.get("include_html") === "1";
  
    if (!week) {
      const now = new Date();
      week = `${now.getFullYear()}-W${getWeekNumber(now)}`;
    }
  
    const cols = "id, category, subject, link, week_of, status, created_at" + (includeHTML ? ", html" : "");
    const q = `SELECT ${cols} FROM essay_queue WHERE week_of = ? ORDER BY ${ORDER}`;
    const res = await env.DB.prepare(q).bind(week).all();
    const rows = res?.results || res || [];
  
    // add human labels
    const items = rows.map(r => ({ ...r, label: LABELS[r.category] || r.category }));
  
    return json({ ok: true, week, count: items.length, items });
  }
  