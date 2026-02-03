export const onRequestGet: PagesFunction = async () => {
    return new Response("ping ok", { headers: { "content-type": "text/plain" } });
  };
  