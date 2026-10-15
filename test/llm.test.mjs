import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuckDuckGoHtml, hasTextLlm, geminiKey, anthropicKey } from '../lib/llm.js';

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
  it('false with empty env', () => {
    assert.equal(hasTextLlm({}), false);
  });
  it('true with GEMINI_API_KEY', () => {
    assert.equal(hasTextLlm({ GEMINI_API_KEY: 'x' }), true);
    assert.equal(geminiKey({ GEMINI_API_KEY: ' abc ' }), 'abc');
  });
  it('true with ANTHROPIC_API_KEY', () => {
    assert.equal(hasTextLlm({ ANTHROPIC_API_KEY: 'y' }), true);
    assert.equal(anthropicKey({ ANTHROPIC_API_KEY: 'y' }), 'y');
  });
});
