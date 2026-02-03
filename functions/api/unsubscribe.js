// CORS helpers
const CORS_ORIGIN = "*";
const withCORS = (res) => {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", CORS_ORIGIN);
  headers.set("access-control-allow-headers", "content-type, api-key");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers });
};

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== "GET") {
    return withCORS(new Response("Method Not Allowed", { status: 405 }));
  }

  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) return withCORS(new Response("Missing token", { status: 400 }));

    const res = await env.DB.prepare(
      "DELETE FROM subscribers WHERE unsub_token = ?"
    ).bind(token).run();

    if (!res.changes) return withCORS(new Response("Invalid or already unsubscribed", { status: 404 }));

    return withCORS(new Response(
      `<h1>Unsubscribed</h1><p>You've been removed from the list.</p>`,
      { headers: { "content-type": "text/html" } }
    ));
  } catch (e) {
    return withCORS(new Response(e?.message || "Error", { status: 500 }));
  }
}
