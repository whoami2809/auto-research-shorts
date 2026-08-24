import { DurableObject } from "cloudflare:workers";

// Mantido para preservar, sem apagar, o namespace criado durante a primeira
// tentativa de Containers. Não recebe tráfego na configuração atual.
export class AppContainer extends DurableObject {
  async fetch(): Promise<Response> {
    return Response.json({ error: "Container não habilitado neste plano" }, { status: 503 });
  }
}

export interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  BACKEND_URL: string;
}

async function serveHtml(request: Request, env: Env, pathname: string): Promise<Response> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(asset.headers);
  // O JavaScript de autenticação e download é inline. HTML antigo em cache ainda
  // fazia navegação direta para /api/video-dl, sem Authorization, causando 401.
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: authorization,
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
    },
  });
  return response.ok;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      if (url.pathname === "/" || url.pathname === "/landing") {
        return serveHtml(request, env, "/landing.html");
      }
      if (url.pathname === "/app") {
        return serveHtml(request, env, "/index.html");
      }
      if (url.pathname === "/privacidade") {
        return serveHtml(request, env, "/privacy.html");
      }
      return env.ASSETS.fetch(request);
    }

    // Frames precisam ser acessíveis pelo Google Lens após um upload autenticado.
    const isPublicFrame = request.method === "GET" && /^\/api\/frame\/[^/]+$/.test(url.pathname);
    if (!isPublicFrame && !(await isAuthenticated(request, env))) {
      return Response.json({ error: "Sessão inválida ou expirada" }, { status: 401 });
    }

    try {
      const backendUrl = new URL(url.pathname + url.search, env.BACKEND_URL);
      return await fetch(new Request(backendUrl, request));
    } catch (error) {
      console.error(JSON.stringify({ event: "backend_fetch_error", error: String(error) }));
      return Response.json({ error: "Serviço temporariamente indisponível" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
