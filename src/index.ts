import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Dispatch = {jobId: string; requestId: string; token: string};
function isDispatch(value: unknown): value is Dispatch {
  if (!value || typeof value !== 'object') return false;
  return 'jobId' in value && typeof value.jobId === 'string' && /^[0-9a-f-]{36}$/.test(value.jobId)
    && 'requestId' in value && typeof value.requestId === 'string' && /^[0-9a-f-]{36}$/.test(value.requestId)
    && 'token' in value && typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token);
}
export class ShortsWorkflow extends WorkflowEntrypoint<Env, Dispatch> {
  async run(event: WorkflowEvent<Dispatch>, step: WorkflowStep) {
    // Only a scoped capability is persisted; no account JWT or provider key enters workflow history.
    if (!isDispatch(event.payload)) return {status: 'invalid'};
    for (let i = 0; i < 100; i++) {
      const lanes = await Promise.all([0,1].map(lane => step.do(`advance-${i}-${lane}`, {retries: {limit: 2, delay: '10 seconds', backoff: 'exponential'}, timeout: '3 minutes'}, async () => {
        const response = await fetch(`${this.env.BACKEND_URL}/api/workflow-dispatch/${event.payload.jobId}`, {
          method: 'POST', headers: {'x-workflow-dispatch':event.payload.token}, redirect: 'error', signal: AbortSignal.timeout(150000),
        });
        if (response.status === 403) return false;
        if (!response.ok) throw new Error('Backend temporariamente indisponível');
        const result: unknown = await response.json();
        return !!result && typeof result === 'object' && 'active' in result && result.active === true;
      })));
      if (!lanes.some(Boolean)) return {status: 'stopped'};
      await step.sleep(`interval-${i}`, '5 seconds');
    }
    return {status: 'time_limit'};
  }
}

// Mantido para preservar, sem apagar, o namespace criado durante a primeira
// tentativa de Containers. Não recebe tráfego na configuração atual.
export class AppContainer extends DurableObject {
  async fetch(): Promise<Response> {
    return Response.json({ error: "Container não habilitado neste plano" }, { status: 503 });
  }
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
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  return response.ok;
}

async function getAnonymousYoutubeVisitorData(videoId: string): Promise<Response> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return Response.json({ error: "ID de vídeo inválido" }, { status: 400 });
  }

  const youtubeResponse = await fetch(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    },
  );

  if (!youtubeResponse.ok) {
    return Response.json(
      { error: "Não foi possível iniciar a sessão anônima do YouTube", status: youtubeResponse.status },
      { status: 502 },
    );
  }

  const html = await youtubeResponse.text();
  const visitorData = html.match(/"visitorData":"([^"\\]+)"/)?.[1];
  if (!visitorData) {
    return Response.json({ error: "Visitor Data anônimo não encontrado" }, { status: 502 });
  }

  return Response.json(
    { visitorData },
    { headers: { "Cache-Control": "private, no-store" } },
  );
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
      if (url.pathname === "/workflow") return serveHtml(request, env, '/workflow.html');
      if (url.pathname === "/privacidade") {
        return serveHtml(request, env, "/privacy.html");
      }
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === '/api/config' && request.method === 'GET') return Response.json({supabaseUrl:env.SUPABASE_URL,supabasePublishableKey:env.SUPABASE_PUBLISHABLE_KEY},{headers:{'Cache-Control':'no-store'}});
    // Internal job dispatch is only called directly by ShortsWorkflow, never proxied from the public edge.
    if (url.pathname.startsWith('/api/workflow-dispatch/')) return Response.json({error:'Não encontrado'},{status:404});
    // Frames precisam ser acessíveis pelo Google Lens após um upload autenticado.
    const isPublicFrame = request.method === "GET" && /^\/api\/frame\/[^/]+$/.test(url.pathname);
    if (!isPublicFrame && !(await isAuthenticated(request, env))) {
      return Response.json({ error: "Sessão inválida ou expirada" }, { status: 401 });
    }

    // O Render está em uma faixa de IP bloqueada pelo YouTube. Esta rota busca
    // somente Visitor Data anônimo a partir da borda Cloudflare; não lê cookies
    // do navegador e continua protegida pelo login Supabase da aplicação.
    if (request.method === "GET" && url.pathname === "/api/youtube-visitor") {
      return getAnonymousYoutubeVisitorData(url.searchParams.get("videoId") || "");
    }

    try {
      const backendUrl = new URL(url.pathname + url.search, env.BACKEND_URL);
      const response = await fetch(new Request(backendUrl, request));
      if (response.status === 202 && request.method === 'POST' && /^\/api\/workflow\/jobs\/[0-9a-f-]+\/(?:stages\/[a-z]+\/)?run$/.test(url.pathname)) {
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object' || !('dispatch' in data) || !isDispatch(data.dispatch)) return Response.json({error:'Despacho inválido'},{status:502});
        const {dispatch,...result}=data;
        const instanceId=`${dispatch.jobId}-${dispatch.requestId}`;
        try {await env.SHORTS_WORKFLOW.create({id:instanceId,params:dispatch});}
        catch {
          // Replayed requests use the same ID. Do not create a second paid workflow.
          try {const instance=await env.SHORTS_WORKFLOW.get(instanceId);await instance.status();}
          catch {return Response.json({...result,warning:'Etapas salvas, mas o coordenador não iniciou. Repita a mesma solicitação.'},{status:202});}
        }
        return Response.json(result,{status:202,headers:{'Cache-Control':'private, no-store'}});
      }
      return response;
    } catch (error) {
      console.error(JSON.stringify({ event: "backend_fetch_error" }));
      return Response.json({ error: "Serviço temporariamente indisponível" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
