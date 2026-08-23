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
        url.pathname = "/landing.html";
        return env.ASSETS.fetch(new Request(url, request));
      }
      if (url.pathname === "/app") {
        url.pathname = "/index.html";
        return env.ASSETS.fetch(new Request(url, request));
      }
      if (url.pathname === "/privacidade") {
        url.pathname = "/privacy.html";
        return env.ASSETS.fetch(new Request(url, request));
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
