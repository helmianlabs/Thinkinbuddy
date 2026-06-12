// api/video.js — Mark's primary "make a video" tool endpoint.
//
// 2026-06-12: REPOINTED to the Sora pipeline. This endpoint previously ran
// Runway veo3 text-to-video, which is NOT enabled on this account — every call
// 502'd before generating, so Mark kept telling Troy "I can't make videos."
// Sora (OPENAI_API_KEY) is the provider that actually works here, and its
// finalize hook in latest-video.js saves the result to media memory.
// The old implementation is preserved at api/video-runway-veo.js.
export { config } from './video-sora.js';
export { default } from './video-sora.js';
