import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  APP_CONTAINER: DurableObjectNamespace<AppContainer>;
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
}

export class AppContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "10m";
  envVars = { NODE_ENV: "production", PORT: "3000" };

  override onError(error: unknown): void {
    console.error(JSON.stringify({ event: "container_error", error: String(error) }));
  }
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
      return env.ASSETS.fetch(request);
    }

    // Frames precisam ser acessíveis pelo Google Lens após um upload autenticado.
    const isPublicFrame = request.method === "GET" && /^\/api\/frame\/[^/]+$/.test(url.pathname);
    if (!isPublicFrame && !(await isAuthenticated(request, env))) {
      return Response.json({ error: "Sessão inválida ou expirada" }, { status: 401 });
    }

    try {
      return await getContainer(env.APP_CONTAINER, "production").fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: "container_fetch_error", error: String(error) }));
      return Response.json({ error: "Serviço temporariamente indisponível" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
