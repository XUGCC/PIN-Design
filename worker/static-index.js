const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;

    const url = new URL(request.url);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    if (!acceptsHtml) return response;

    const candidates = url.pathname === "/"
      ? ["/index.html"]
      : [`${url.pathname}.html`, `${url.pathname.replace(/\/$/, "")}/index.html`, "/404.html"];
    for (const pathname of candidates) {
      const fallbackUrl = new URL(pathname, url);
      const fallback = await env.ASSETS.fetch(new Request(fallbackUrl, { headers: request.headers }));
      if (fallback.status !== 404) return fallback;
    }
    return response;
  },
};

export default worker;
