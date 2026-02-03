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
  
  if (request.method !== "GET") {
    return withCORS(new Response("Method Not Allowed", { status: 405 }));
  }

  const PRODUCT_HUNT_TOKEN = 'VoFOtC1kQKY4BSJGwRGpKy5YTLx3frYUqmzWHj4A_hU';

  const query = `
    query GetRecentProducts {
      posts(first: 10, order: VOTES) {
        edges {
          node {
            id
            name
            tagline
            description
            url
            website
            featuredAt
            topics {
              edges {
                node {
                  name
                  slug
                }
              }
            }
            thumbnail {
              url
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch('https://api.producthunt.com/v2/api/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PRODUCT_HUNT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();
    
    if (!response.ok) {
      return json({ error: 'Product Hunt API error', details: data }, 500);
    }

    return json({ 
      success: true, 
      products: data.data.posts.edges.map(edge => edge.node),
      count: data.data.posts.edges.length 
    });

  } catch (error) {
    return json({ error: 'Failed to fetch products', message: error.message }, 500);
  }
}
