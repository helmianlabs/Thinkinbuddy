// Final-sweep tests (bite 8) — one describe per checklist item that
// changed behavior:
//   #3 router function-config map covers every handler-declared config
//   #5 ENFORCE_TOOL_AUTH truthy parsing is shared (lib/security.js)
//   #6 research-log stores redacted metadata only, never raw content
//   #7 media endpoints + memory-admin require + scope to the tenant
//      session in enforced mode; compat behavior unchanged
//   #8 dead providers (Sora / Imagen) are unrouted and deleted
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  isTruthyEnvFlag,
  isToolAuthEnforced,
  requireToolAuth,
} from '../lib/security.js';
import { signSession } from '../lib/tenant.js';
import { buildResearchLogMetadata } from '../server/handlers/research-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'sweep-test-session-secret';
const TENANT_A = '11111111-1111-4111-8111-111111111111';

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end(payload) { if (payload) this.body = payload; return this; },
  };
}

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withEnvAsync(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ─── #3: router function config ──────────────────────────────────────────
describe('router function config (sweep #3)', () => {
  it('the map covers every handler that declares a config, with equal values', async () => {
    const router = await import('../api/[...path].js');
    const handlerDir = join(ROOT, 'server', 'handlers');
    let declared = 0;
    for (const file of readdirSync(handlerDir)) {
      if (!file.endsWith('.js')) continue;
      const src = readFileSync(join(handlerDir, file), 'utf8');
      const route = file.replace(/\.js$/, '');
      // Bare `export const maxDuration` is NOT a config shape Vercel or
      // this sweep recognizes — it must not come back.
      assert.ok(
        !/export\s+const\s+maxDuration\s*=/.test(src),
        `${file} declares a bare maxDuration export; use export const config`,
      );
      const cfg = src.match(/export\s+const\s+config\s*=\s*\{([^}]*)\}/);
      if (!cfg) continue;
      const dur = cfg[1].match(/maxDuration:\s*(\d+)/);
      if (dur) {
        declared++;
        assert.equal(
          router.ROUTE_MAX_DURATIONS[route],
          Number(dur[1]),
          `${file} declares maxDuration ${dur[1]} but the router map has ${router.ROUTE_MAX_DURATIONS[route]}`,
        );
      }
      const size = cfg[1].match(/sizeLimit:\s*'([^']+)'/);
      if (size) {
        assert.equal(
          router.ROUTE_FUNCTION_CONFIG[route]?.api?.bodyParser?.sizeLimit,
          size[1],
          `${file} declares body sizeLimit ${size[1]} missing from the router map`,
        );
      }
    }
    assert.ok(declared >= 5, `expected several maxDuration handlers, found ${declared}`);
  });

  it('the router platform config carries the max duration and largest body limit', async () => {
    const router = await import('../api/[...path].js');
    const durations = Object.values(router.ROUTE_MAX_DURATIONS);
    assert.equal(router.config.maxDuration, Math.max(...durations));
    assert.equal(router.config.maxDuration, 300); // the video routes' ceiling
    assert.equal(router.config.api.bodyParser.sizeLimit, '25mb'); // actionable's
    for (const route of ['video', 'video-runway', 'video-runway-veo']) {
      assert.equal(router.ROUTE_MAX_DURATIONS[route], 300, `${route} must keep its 300s`);
    }
  });
});

// ─── #5: shared truthy parsing for ENFORCE_TOOL_AUTH ─────────────────────
describe('tool-auth flag parsing (sweep #5, audit gap 9)', () => {
  it('accepts the full truthy set, case- and space-insensitively', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'on', ' true ', ' 1']) {
      assert.equal(isTruthyEnvFlag(v), true, JSON.stringify(v));
    }
  });

  it('rejects everything else, including unset and non-strings', () => {
    for (const v of ['0', 'false', 'no', 'off', '', '2', 'enabled', undefined, null, 1, true]) {
      assert.equal(isTruthyEnvFlag(v), false, JSON.stringify(v));
    }
  });

  it("the documented spelling 'true' now actually enforces (the gap-9 bug)", () => {
    withEnv({ ENFORCE_TOOL_AUTH: 'true', WEBHOOK_SECRET: 'sekret' }, () => {
      assert.equal(isToolAuthEnforced(), true);
      const res = mockRes();
      const allowed = requireToolAuth({ headers: {} }, res);
      assert.equal(allowed, false);
      assert.equal(res.statusCode, 401);
    });
  });

  it("'1' enforces too, and a correct secret passes under either spelling", () => {
    for (const spelling of ['1', 'true']) {
      withEnv({ ENFORCE_TOOL_AUTH: spelling, WEBHOOK_SECRET: 'sekret' }, () => {
        const res = mockRes();
        assert.equal(requireToolAuth({ headers: { 'x-webhook-secret': 'sekret' } }, res), true);
      });
    }
  });

  it('flag off (or absent) leaves tool auth open, as designed', () => {
    for (const patch of [{ ENFORCE_TOOL_AUTH: 'false' }, { ENFORCE_TOOL_AUTH: undefined }]) {
      withEnv({ ...patch, WEBHOOK_SECRET: 'sekret' }, () => {
        assert.equal(isToolAuthEnforced(), false);
        assert.equal(requireToolAuth({ headers: {} }, mockRes()), true);
      });
    }
  });

  it('no other file parses ENFORCE_TOOL_AUTH by hand anymore', () => {
    // Every reader must go through lib/security.js's shared helper.
    // Scan the code dirs for an actual env READ of the flag outside that
    // helper (comments naming the flag are fine; docs and tests are
    // excluded — this file sets it on purpose).
    for (const dir of ['lib', 'server', 'api', 'scripts']) {
      for (const file of readdirSync(join(ROOT, dir), { recursive: true })) {
        const name = String(file);
        if (!/\.(js|mjs|ts)$/.test(name) || name === 'security.js') continue;
        const src = readFileSync(join(ROOT, dir, name), 'utf8');
        assert.ok(
          !/(?:process\.env|env)\??\.?\s*(?:\.\s*ENFORCE_TOOL_AUTH|\[\s*['"]ENFORCE_TOOL_AUTH)/.test(src),
          `${dir}/${name} reads ENFORCE_TOOL_AUTH directly — use isToolAuthEnforced()`,
        );
      }
    }
  });
});

// ─── #6: research-log redaction ──────────────────────────────────────────
describe('research-log redaction (sweep #6, audit gap 11)', () => {
  const SECRET_TEXT = 'my secret diary entry about grandma';
  const conversation = [
    { role: 'user', content: SECRET_TEXT },
    { role: 'assistant', content: 'a reply that must not be stored either' },
    { role: 'user', content: [{ type: 'text', text: 'nested secret text' }] },
  ];

  it('the stored metadata contains NO message content or caller strings', () => {
    const meta = buildResearchLogMetadata(conversation, {
      userId: 'troy-the-person',
      researchTag: 'CONFIDENTIAL-TAG',
      ageRange: '6-8',
      consentDate: '2026-10-23',
    });
    const serialized = JSON.stringify(meta);
    for (const leak of [SECRET_TEXT, 'grandma', 'a reply that must not be stored', 'nested secret text', 'troy-the-person', 'CONFIDENTIAL-TAG', '6-8']) {
      assert.ok(!serialized.includes(leak), `metadata leaks: ${leak}`);
    }
  });

  it('keeps only counts, roles, and lengths — enough for aggregate research', () => {
    const meta = buildResearchLogMetadata(conversation, { userId: 'u1', consentDate: 'x' });
    assert.equal(meta.message_count, 3);
    assert.equal(meta.user_message_count, 2);
    assert.equal(meta.assistant_message_count, 1);
    assert.equal(meta.messages[0].content_length, SECRET_TEXT.length);
    assert.equal(meta.consent_recorded, true);
    assert.match(meta.participant_hash, /^[0-9a-f]{64}$/);
  });

  it('the handler source no longer builds a raw transcript document', () => {
    const src = readFileSync(join(ROOT, 'server', 'handlers', 'research-log.js'), 'utf8');
    assert.ok(!src.includes('## Full Conversation'), 'raw transcript heading is gone');
    assert.ok(!src.includes('text/markdown'), 'no markdown transcript upload');
    assert.ok(src.includes('buildResearchLogMetadata'), 'handler persists via the redactor');
  });
});

// ─── #7 (+#4): tenant scoping in enforced mode ──────────────────────────
describe('media endpoints + memory-admin tenant scoping (sweep #4/#7, audit gap 12)', () => {
  it('media-gallery: enforced mode without a session is a 401', async () => {
    const { default: handler } = await import('../server/handlers/media-gallery.js');
    await withEnvAsync({ SESSION_SECRET: SECRET }, async () => {
      const res = mockRes();
      await handler({ method: 'GET', headers: {}, query: { userId: TENANT_A } }, res);
      assert.equal(res.statusCode, 401);
    });
  });

  it('media-gallery: compat mode is unchanged (userId still required, no 401)', async () => {
    const { default: handler } = await import('../server/handlers/media-gallery.js');
    await withEnvAsync({ SESSION_SECRET: undefined }, async () => {
      const res = mockRes();
      await handler({ method: 'GET', headers: {}, query: {} }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'userId required');
    });
  });

  it('latest-image / latest-video: enforced mode without a session is a 401', async () => {
    const img = (await import('../server/handlers/latest-image.js')).default;
    const vid = (await import('../server/handlers/latest-video.js')).default;
    await withEnvAsync({ SESSION_SECRET: SECRET }, async () => {
      for (const handler of [img, vid]) {
        const res = mockRes();
        await handler({ method: 'GET', headers: {}, query: { userId: 'someone-else' } }, res);
        assert.equal(res.statusCode, 401);
      }
    });
  });

  it('latest-image / latest-video: compat mode is unchanged (no token -> empty 200)', async () => {
    const img = (await import('../server/handlers/latest-image.js')).default;
    const vid = (await import('../server/handlers/latest-video.js')).default;
    await withEnvAsync({ SESSION_SECRET: undefined, BLOB_READ_WRITE_TOKEN: undefined }, async () => {
      for (const handler of [img, vid]) {
        const res = mockRes();
        await handler({ method: 'GET', headers: {}, query: {} }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { url: null });
      }
    });
  });

  it('memory-admin: enforced mode without a session is a 401 (after the webhook gate)', async () => {
    const { default: handler } = await import('../server/handlers/memory-admin.js');
    await withEnvAsync({ SESSION_SECRET: SECRET, WEBHOOK_SECRET: 'op-secret' }, async () => {
      const res = mockRes();
      await handler({
        method: 'GET',
        headers: { origin: 'https://thinkinbuddy.vercel.app', 'x-webhook-secret': 'op-secret' },
        query: { userId: TENANT_A },
      }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'Unauthorized');
    });
  });

  it('memory-admin: the webhook-secret gate still fires first when the secret is wrong', async () => {
    const { default: handler } = await import('../server/handlers/memory-admin.js');
    await withEnvAsync({ SESSION_SECRET: SECRET, WEBHOOK_SECRET: 'op-secret' }, async () => {
      const res = mockRes();
      await handler({
        method: 'GET',
        headers: { origin: 'https://thinkinbuddy.vercel.app', 'x-webhook-secret': 'wrong' },
        query: { userId: TENANT_A },
      }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.result, 'Unauthorized');
    });
  });

  it('resolveScopedRequestIdentity: enforced session REPLACES the caller userId', async () => {
    const { resolveScopedRequestIdentity } = await import('../lib/tenant.js');
    await withEnvAsync({ SESSION_SECRET: SECRET }, async () => {
      const token = signSession(TENANT_A, SECRET, 600);
      const req = { headers: { authorization: `Bearer ${token}` } };
      const scoped = resolveScopedRequestIdentity(req, mockRes(), 'some-other-user');
      assert.equal(scoped.ok, true);
      assert.equal(scoped.enforced, true);
      assert.equal(scoped.tenantId, TENANT_A);
      assert.equal(scoped.userId, TENANT_A); // never the caller's value
    });
  });
});

// ─── #8: dead providers stay dead ────────────────────────────────────────
describe('dead providers removed (sweep #8)', () => {
  it('the Sora and Imagen handler files are deleted', () => {
    assert.equal(existsSync(join(ROOT, 'server', 'handlers', 'video-sora.js')), false);
    assert.equal(existsSync(join(ROOT, 'server', 'handlers', 'image-imagen.js')), false);
  });

  it('the router has no route for them', () => {
    const src = readFileSync(join(ROOT, 'api', '[...path].js'), 'utf8');
    assert.ok(!src.includes('video-sora'), 'router must not load video-sora');
    assert.ok(!src.includes('image-imagen'), 'router must not load image-imagen');
  });
});
