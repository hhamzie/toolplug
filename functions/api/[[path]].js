export async function onRequest(context) {
    const { request, env } = context;
    
    // Let Pages serve your static assets (index.html, app.js, style.css, etc.)
    if (request.method === "GET" || request.method === "HEAD") {
      return env.ASSETS.fetch(request);
    }
    
    // CORS helper
    const withCORS = (res) => {
      const headers = new Headers(res.headers);
      headers.set("access-control-allow-origin", "*");
      headers.set("access-control-allow-headers", "content-type, api-key");
      headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
      return new Response(res.body, { status: res.status, headers });
    };
    
    return withCORS(new Response("Not found", { status: 404 }));
  }
  