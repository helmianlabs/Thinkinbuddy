// api/latest-image.js — returns the most recently generated image URL.
// The page polls this every 3 seconds while a conversation is active.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(200).json({ url: null });

  try {
    const response = await fetch(
      'https://blob.vercel-storage.com/thinkinbuddy/latest-image.json',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) return res.status(200).json({ url: null });
    const data = await response.json();
    return res.status(200).json(data);
  } catch {
    return res.status(200).json({ url: null });
  }
}
