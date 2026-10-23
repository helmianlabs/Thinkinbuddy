// Single router for the Thinkinbuddy API so the app fits Vercel Hobby's 12-function limit.
// /api/<name>[/sub/path] -> server/handlers/<name>.js (same URLs as before).
// api/conversation-webhook.js stays its own function because it needs the raw body (bodyParser: false).

// ─── Per-route function config (audit fix-list item 6) ──────────────────
// Handlers used to declare their own `export const config` (maxDuration,
// body-size limits). Those exports are dead in this layout: Vercel reads
// function config from the ACTUAL function file — this router — never
// from a module the router dynamically imports. The values every handler
// declared are therefore lifted here, route by route, so they are
// visible, testable, and survive a future split back into per-route
// functions.
//
// One consolidated function can carry only ONE platform-level config,
// so the exported `config` below takes the maximum maxDuration (300s)
// and the largest body limit (Actionable's 25 MB) across the routed
// handlers. ROUTE_FUNCTION_CONFIG preserves each route's own declared
// values exactly; ROUTE_MAX_DURATIONS is the maxDuration projection the
// sweep test checks against every handler that declares one. A route's
// lower individual ceiling cannot be enforced separately while all
// routes share this one function — that needs per-route functions.
export const ROUTE_FUNCTION_CONFIG = {
  'actionable': { api: { bodyParser: { sizeLimit: '25mb' } } },
  'diary': { api: { bodyParser: { sizeLimit: '10mb' } } },
  'image-flux': { maxDuration: 120 },
  'mcp': { api: { bodyParser: { sizeLimit: '1mb' } } },
  'relay-http': { maxDuration: 15 },
  'video': { maxDuration: 300 },
  'video-runway': { maxDuration: 300 },
  'video-runway-veo': { maxDuration: 300 },
};

export const ROUTE_MAX_DURATIONS = Object.freeze(Object.fromEntries(
  Object.entries(ROUTE_FUNCTION_CONFIG)
    .filter(([, config]) => Number.isFinite(config.maxDuration))
    .map(([route, config]) => [route, config.maxDuration]),
));

// Platform config for THIS function (the only one Vercel reads for every
// route above): the maximum duration and largest body limit any routed
// handler declared. vercel.json's functions entry for this file carries
// the same 300s maxDuration.
export const config = {
  maxDuration: 300,
  api: { bodyParser: { sizeLimit: '25mb' } },
};

const routes = {
  'actionable': () => import('../server/handlers/actionable.js'),
  'actionable-auth': () => import('../server/handlers/actionable-auth.js'),
  'actionable-config': () => import('../server/handlers/actionable-config.js'),
  'actionable-google-callback': () => import('../server/handlers/actionable-google-callback.js'),
  'actionable-integrations': () => import('../server/handlers/actionable-integrations.js'),
  'actionable-oauth-callback': () => import('../server/handlers/actionable-oauth-callback.js'),
  'actionable-search': () => import('../server/handlers/actionable-search.js'),
  'ai-test': () => import('../server/handlers/ai-test.js'),
  'alarm': () => import('../server/handlers/alarm.js'),
  'auth': () => import('../server/handlers/auth.js'),
  'billing-webhook': () => import('../server/handlers/billing-webhook.js'),
  'browse': () => import('../server/handlers/browse.js'),
  'chat': () => import('../server/handlers/chat.js'),
  'conversation-history': () => import('../server/handlers/conversation-history.js'),
  'conversation-turn': () => import('../server/handlers/conversation-turn.js'),
  'cron-expire-memories': () => import('../server/handlers/cron-expire-memories.js'),
  'diary': () => import('../server/handlers/diary.js'),
  'extract-memories': () => import('../server/handlers/extract-memories.js'),
  'image': () => import('../server/handlers/image.js'),
  'image-flux': () => import('../server/handlers/image-flux.js'),
  'latest-image': () => import('../server/handlers/latest-image.js'),
  'latest-video': () => import('../server/handlers/latest-video.js'),
  'mcp': () => import('../server/handlers/mcp.js'),
  'media-gallery': () => import('../server/handlers/media-gallery.js'),
  'memory': () => import('../server/handlers/memory.js'),
  'memory-admin': () => import('../server/handlers/memory-admin.js'),
  'prime-agent': () => import('../server/handlers/prime-agent.js'),
  'profile': () => import('../server/handlers/profile.js'),
  'recall-memory': () => import('../server/handlers/recall-memory.js'),
  'relay-http': () => import('../server/handlers/relay-http.js'),
  'relay-pair': () => import('../server/handlers/relay-pair.js'),
  'relay-proxy': () => import('../server/handlers/relay-proxy.js'),
  'research-log': () => import('../server/handlers/research-log.js'),
  'search': () => import('../server/handlers/search.js'),
  'speak': () => import('../server/handlers/speak.js'),
  'task': () => import('../server/handlers/task.js'),
  'video': () => import('../server/handlers/video.js'),
  'video-heygen': () => import('../server/handlers/video-heygen.js'),
  'video-runway': () => import('../server/handlers/video-runway.js'),
  'video-runway-veo': () => import('../server/handlers/video-runway-veo.js'),
  'voices': () => import('../server/handlers/voices.js'),
};

export default async function handler(req, res) {
  const pathname = new URL(req.url, 'http://local').pathname;
  const name = pathname.replace(/^\/api\/?/, '').split('/')[0];
  const load = routes[name];
  if (!load) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Not found', path: pathname }));
  }
  if (req.query) delete req.query.path;
  // Make the route's declared config visible to the handler and to
  // anyone debugging a timeout from response headers. (Informational:
  // the platform ceiling is the exported `config` above.)
  req.routeFunctionConfig = ROUTE_FUNCTION_CONFIG[name] || {};
  req.routeMaxDuration = ROUTE_MAX_DURATIONS[name] ?? null;
  if (req.routeMaxDuration && typeof res.setHeader === 'function') {
    res.setHeader('X-Route-Max-Duration', String(req.routeMaxDuration));
  }
  const mod = await load();
  return mod.default(req, res);
}
