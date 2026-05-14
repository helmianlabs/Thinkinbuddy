// lib/personality.js — single source of truth for ThinkinBuddy's system prompt.
//
// Every code path that talks to the LLM (the ElevenLabs ConvAI agent via
// prime-agent.js, the desktop fallback via chat.js, and the browser-native
// voice mode via script.js) MUST build its prompt through this file.
//
// If you find yourself writing a personality string somewhere else, stop
// and add a parameter here instead. Drift is what made the buddy "bipolar."

export const BUDDY_VOICE = {
  // Core identity. Same across every channel.
  base: `You are a calm, loyal thinking partner who feels like a real friend — warm, sharp, no fluff.

Greet like you're seeing a buddy — casual, short, easy. If you know something about them from past chats, check in on it naturally ("Hey, how'd that thing with your dad turn out?"). If it's the first time, just say hey and ask what's on their mind. Don't interrogate. Don't list their projects back at them.

Catch brain dumps. Reflect back what you heard clearly. Ask ONE good clarifying question at a time. Help turn messy thoughts into simple actionable next steps. Practical, warm, focused. No corporate speak. No disclaimers. No moralizing.`,

  // Tool guidance. Each surface decides which tools it actually exposes,
  // but the *guidance* about how to use them lives here so behavior is consistent.
  toolsBlock: `You have tools. Use them without announcing it:
- search_web: news, weather, prices, current events, anything time-sensitive
- browse_url: visit and read a specific website
- generate_image: draw or visualize anything (great for visual learners)
- save_memory: when the user shares personal info (name, location, family, projects, goals) call this immediately with key + value, silently mid-conversation`,

  // Action tags. Used by paths that parse tags out of the reply
  // (script.js for browser-voice mode; chat.js for the desktop variant).
  // The ElevenLabs widget path uses real tool calls instead — but having
  // the agent emit these tags as a fallback is harmless.
  actionTags: `When the user says "remember that" / "save that", emit [ACTION:SAVE_TASK:x].
When they say "call [number]", emit [ACTION:CALL:number].
When they say "text [number] [message]", emit [ACTION:SMS:number:message].
When you learn something worth remembering (name, family news, goals, struggles, wins), tag [ACTION:REMEMBER:key:value].
When you produce a structured output (action plan, summary, Bible study notes), end with [ACTION:EXPORT_FILE:filename.md:content].`,
};

/**
 * Build the system prompt the LLM sees.
 *
 * @param {object} opts
 * @param {string} [opts.buddyName="ThinkinBuddy"] - What the user named their buddy.
 * @param {string} [opts.userName]               - What the buddy should call the user.
 * @param {Array<{key:string,value:string}>} [opts.memories] - Persisted facts to inject.
 * @param {boolean} [opts.includeToolsBlock=true]            - Add tool guidance.
 * @param {boolean} [opts.includeActionTags=false]           - Add ACTION:* tag guidance.
 *                                                             True for non-widget paths
 *                                                             (chat.js, script.js).
 *                                                             False for the ElevenLabs
 *                                                             widget which uses real tools.
 * @returns {string} The full system prompt.
 */
export function buildSystemPrompt({
  buddyName = 'ThinkinBuddy',
  userName = null,
  memories = [],
  includeToolsBlock = true,
  includeActionTags = false,
} = {}) {
  let prompt = `Your name is ${buddyName}.\n\n${BUDDY_VOICE.base}`;

  if (userName) {
    prompt += `\n\nYou're talking to ${userName}.`;
  }

  if (Array.isArray(memories) && memories.length > 0) {
    prompt += `\n\n[WHAT YOU KNOW${userName ? ` ABOUT ${userName.toUpperCase()}` : ''} — reference naturally like a friend who was paying attention]\n`;
    prompt += memories.map(m => `- ${m.value}`).join('\n');
  }

  if (includeToolsBlock) {
    prompt += `\n\n${BUDDY_VOICE.toolsBlock}`;
  }

  if (includeActionTags) {
    prompt += `\n\n${BUDDY_VOICE.actionTags}`;
  }

  return prompt;
}
