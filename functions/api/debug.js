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

const normEmail = (e) => String(e || "").toLowerCase().trim();

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== "GET") {
    return withCORS(new Response("Method Not Allowed", { status: 405 }));
  }
  
  const url = new URL(request.url);
  const qEmail = normEmail(url.searchParams.get("email"));
  if (!qEmail) return withCORS(new Response("Missing email", { status: 400 }));
  
  try {
    const pendingRow = await env.DB
      .prepare("SELECT id,email,send_day,categories,token,created_at FROM subscribers_pending WHERE email = ? ORDER BY id DESC LIMIT 1")
      .bind(qEmail).first();
    const subscribedRow = await env.DB
      .prepare("SELECT id,email,send_day,categories,unsub_token,created_at FROM subscribers WHERE email = ? ORDER BY id DESC LIMIT 1")
      .bind(qEmail).first();
    return json({
      pending: !!pendingRow,
      subscribed: !!subscribedRow,
      pendingRow: pendingRow || null,
      subscribedRow: subscribedRow || null,
    });
  } catch (e) {
    return withCORS(new Response(e?.message || "Error", { status: 500 }));
  }
}
