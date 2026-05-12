// api/latest-image.js — returns the most recently generated image.
// Reads from in-memory cache set by /api/image.
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const img = global.__latestImage;
  // Only return if generated in the last 55 minutes (OpenAI URLs expire at 60)
  if (img && (Date.now() - img.timestamp) < 55 * 60 * 1000) {
    return res.status(200).json(img);
  }
  return res.status(200).json({ url: null });
}
