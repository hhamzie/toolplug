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
  
  if (request.method !== "GET") {
    return withCORS(new Response("Method Not Allowed", { status: 405 }));
  }
  
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return withCORS(new Response("Missing token", { status: 400 }));
  
  try {
    const pendingRow = await env.DB
      .prepare("SELECT id,email,send_day,categories,token,created_at FROM subscribers_pending WHERE token = ? LIMIT 1")
      .bind(token).first();
    const recently = await env.DB
      .prepare("SELECT id,email,send_day,categories,unsub_token,created_at FROM subscribers ORDER BY id DESC LIMIT 5")
      .first();
    return json({ in_pending: !!pendingRow, pendingRow: pendingRow || null, sampleRecent: recently || null });
  } catch (e) {
    return withCORS(new Response(e?.message || "Error", { status: 500 }));
  }
}
