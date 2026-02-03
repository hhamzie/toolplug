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
  const { env } = context;
  
  return json({
    hasAI: !!env.AI,
    hasDB: !!env.DB,
    hasAssets: !!env.ASSETS,
    envKeys: Object.keys(env || {}),
  });
}
