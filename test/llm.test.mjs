import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuckDuckGoHtml,
  hasTextLlm,
  geminiKey,
  anthropicKey,
  preferredBrain,
  preferredModel,
  keyForProvider,
  DEFAULT_MODELS,
} from '../lib/llm.js';

describe('parseDuckDuckGoHtml', () => {
  it('extracts title url snippet from sample markup', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example <b>Title</b></a>
        <a class="result__snippet" href="#">A short snippet about the page.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fother.org%2F">Other</a>
        <div class="result__snippet">Second hit.</div>
      </div>`;
    const hits = parseDuckDuckGoHtml(html, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].url, 'https://example.com/page');
    assert.match(hits[0].title, /Example/);
    assert.match(hits[0].snippet, /short snippet/);
  });

  it('skips duckduckgo.com noise links', () => {
    const html = `<a class="result__a" href="https://duckduckgo.com/foo">Noise</a>`;
    assert.equal(parseDuckDuckGoHtml(html).length, 0);
  });
});

describe('hasTextLlm', () => {
  it('false with empty env and no req', () => {
    assert.equal(hasTextLlm(null, {}), false);
  });
  it('true with GEMINI_API_KEY in env', () => {
    assert.equal(hasTextLlm(null, { GEMINI_API_KEY: 'x' }), true);
    assert.equal(geminiKey({ GEMINI_API_KEY: ' abc ' }), 'abc');
  });
  it('true with ANTHROPIC_API_KEY in env', () => {
    assert.equal(hasTextLlm(null, { ANTHROPIC_API_KEY: 'y' }), true);
    assert.equal(anthropicKey({ ANTHROPIC_API_KEY: 'y' }), 'y');
  });
  it('true with user OpenAI header even if env empty', () => {
    const req = { headers: { 'x-user-key-openai': 'sk-test' } };
    assert.equal(hasTextLlm(req, {}), true);
  });
});

describe('preferredBrain / model / keyForProvider', () => {
  it('defaults to gemini', () => {
    assert.equal(preferredBrain({ headers: {} }), 'gemini');
  });
  it('reads X-User-Brain and aliases', () => {
    assert.equal(preferredBrain({ headers: { 'x-user-brain': 'openai' } }), 'openai');
    assert.equal(preferredBrain({ headers: { 'x-user-brain': 'grok' } }), 'xai');
    assert.equal(preferredBrain({ headers: { 'x-user-brain': 'claude' } }), 'anthropic');
  });
  it('model header overrides default', () => {
    assert.equal(preferredModel({ headers: {} }, 'gemini'), DEFAULT_MODELS.gemini);
    assert.equal(preferredModel({ headers: { 'x-user-model': 'gpt-4.1' } }, 'openai'), 'gpt-4.1');
  });
  it('user key beats env for openai', () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-env';
    try {
      const r = keyForProvider({ headers: { 'x-user-key-openai': 'sk-user' } }, 'openai');
      assert.equal(r.key, 'sk-user');
      assert.equal(r.source, 'user');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
