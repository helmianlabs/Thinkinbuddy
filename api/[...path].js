// Single router for the Thinkinbuddy API so the app fits Vercel Hobby's 12-function limit.
// /api/<name>[/sub/path] -> server/handlers/<name>.js (same URLs as before).
// api/conversation-webhook.js stays its own function because it needs the raw body (bodyParser: false).
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
  'browse': () => import('../server/handlers/browse.js'),
  'chat': () => import('../server/handlers/chat.js'),
  'conversation-history': () => import('../server/handlers/conversation-history.js'),
  'conversation-turn': () => import('../server/handlers/conversation-turn.js'),
  'cron-expire-memories': () => import('../server/handlers/cron-expire-memories.js'),
  'diary': () => import('../server/handlers/diary.js'),
  'extract-memories': () => import('../server/handlers/extract-memories.js'),
  'image': () => import('../server/handlers/image.js'),
  'image-flux': () => import('../server/handlers/image-flux.js'),
  'image-imagen': () => import('../server/handlers/image-imagen.js'),
  'latest-image': () => import('../server/handlers/latest-image.js'),
  'latest-video': () => import('../server/handlers/latest-video.js'),
  'mcp': () => import('../server/handlers/mcp.js'),
  'media-gallery': () => import('../server/handlers/media-gallery.js'),
  'memory': () => import('../server/handlers/memory.js'),
  'memory-admin': () => import('../server/handlers/memory-admin.js'),
  'prime-agent': () => import('../server/handlers/prime-agent.js'),
  'recall-memory': () => import('../server/handlers/recall-memory.js'),
  'relay-http': () => import('../server/handlers/relay-http.js'),
  'relay-proxy': () => import('../server/handlers/relay-proxy.js'),
  'research-log': () => import('../server/handlers/research-log.js'),
  'search': () => import('../server/handlers/search.js'),
  'speak': () => import('../server/handlers/speak.js'),
  'task': () => import('../server/handlers/task.js'),
  'video': () => import('../server/handlers/video.js'),
  'video-heygen': () => import('../server/handlers/video-heygen.js'),
  'video-runway': () => import('../server/handlers/video-runway.js'),
  'video-runway-veo': () => import('../server/handlers/video-runway-veo.js'),
  'video-sora': () => import('../server/handlers/video-sora.js'),
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
  const mod = await load();
  return mod.default(req, res);
}
