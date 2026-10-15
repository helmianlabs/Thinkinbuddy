export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { put, list, del } = await import('@vercel/blob');

  if (req.method === 'POST') {
    const { task, project } = req.body || {};
    if (!task) return res.status(400).json({ error: 'task is required' });

    const id = Date.now();
    const entry = { id, task, project: project || 'general', created: new Date().toISOString() };

    try {
      await put(`tasks/${id}.json`, JSON.stringify(entry), {
        access: 'public',
        contentType: 'application/json'
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, name: e.constructor.name });
    }

    return res.status(200).json({ ok: true, message: `Got it. Task saved for Clyde: ${task}` });
  }

  if (req.method === 'GET') {
    const { blobs } = await list({ prefix: 'tasks/' });
    const tasks = await Promise.all(
      blobs.map(b => fetch(b.url).then(r => r.json()).catch(() => null))
    );
    return res.status(200).json(tasks.filter(Boolean).sort((a, b) => a.id - b.id));
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    const { blobs } = await list({ prefix: `tasks/${id}` });
    if (blobs.length) await del(blobs[0].url);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
