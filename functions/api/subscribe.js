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
  
  if (request.method === "OPTIONS") {
    return withCORS(new Response(null, { status: 204 }));
  }
  
  if (request.method !== "POST") {
    return withCORS(new Response("Method Not Allowed", { status: 405 }));
  }

  try {
    const { email, send_day, categories } = await request.json();

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return withCORS(new Response("Invalid email", { status: 400 }));
    }
    const day = Number(send_day);
    if (!(day >= 0 && day <= 6)) {
      return withCORS(new Response("Invalid send_day", { status: 400 }));
    }
    if (!Array.isArray(categories) || categories.length === 0) {
      return withCORS(new Response("Pick at least one category", { status: 400 }));
    }

    const token = crypto.randomUUID();

    await env.DB.prepare(
      "INSERT INTO subscribers_pending (email, send_day, categories, token) VALUES (?, ?, ?, ?)"
    )
      .bind(normEmail(email), day, categories.join(","), token)
      .run();

    // Use the actual request host to avoid cross-host mismatch
    const host = request.headers.get("host") || env.DOMAIN;
    const confirmUrl = `https://${host}/api/confirm?token=${encodeURIComponent(token)}`;

    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: `hello@${env.DOMAIN}`, name: "ToolPlug" },
        replyTo: { email: `hello@${env.DOMAIN}`, name: "ToolPlug" },
        to: [{ email }],
        subject: "Confirm your ToolPlug subscription",
        textContent: `Hey Friend!

You asked to receive a weekly tool pick from ToolPlug! 

Confirm here: ${confirmUrl}

If you didn't request this, you can ignore this email, and you'll never hear from us again.`,
        htmlContent: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;background:linear-gradient(135deg, #fefefe 0%, #f8f9ff 50%, #f0f4ff 100%);padding:24px;text-align:center;">
          <div style="max-width:400px;margin:auto;background:rgba(255, 255, 255, 0.95);padding:24px;border-radius:16px;box-shadow:0 12px 24px rgba(155, 107, 158, 0.15);border:1px solid rgba(155, 107, 158, 0.25);backdrop-filter:blur(10px);">
            <div style="font-size:32px;">🔌⚡</div>
            <h2>Welcome to <span style="color:#9B6B9E;">ToolPlug</span>! </h2>
            <p>
              Hi <b>tool lover</b>!<br>
              You're one click away from <b>weekly drops</b> in:<br>
              <span style="background:rgba(155, 107, 158, 0.1);padding:6px 10px;border-radius:8px;display:inline-block;border:1px solid rgba(155, 107, 158, 0.2);">
                🖥️ 🎨 📊 ⚙️ 🎬 🎲
              </span>
            </p>
            <p style="margin:30px 0;">
              <a href="${confirmUrl}"
                 style="display:inline-block;padding:12px 26px;background:#9B6B9E;color:#fff;font-size:18px;border-radius:8px;font-weight:bold;text-decoration:none;box-shadow:0 4px 12px rgba(155, 107, 158, 0.3);transition:all 0.25s ease;">
                Confirm & Get Started ✅
              </a>
            </p>

            <p style="font-size:12px; color:#6B7280;">
              Didn't request this? Just ignore!<br>
            </p>
          </div>
        </div>
      `,
      }),
    });

    if (!r.ok) {
      return withCORS(new Response(`Brevo error: ${await r.text()}`, { status: 502 }));
    }

    return json({ ok: true });
  } catch (e) {
    return withCORS(new Response(e?.message || "Error", { status: 500 }));
  }
}