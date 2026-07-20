// Faith & Light image rehost script
// Snapshot the current Printful temp S3 mockups (still live today) and re-host to imgbb (permanent)
// Then update Stripe images[0] to point at the imgbb URL.
// Preserves 100% visual identity. Rule 0.6 — batches of 5, verify each, recovery log per-product.

import fs from 'fs';

const STRIPE_KEY = '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';
const IMGBB_KEY = 'b67478e1eaa85b0a7de79e6793c525f8';
const TEST_IDS = new Set(['prod_UaTjyJkLseaVU5', 'prod_UaTjJBWJJqhdy9', 'prod_UaTjZ7PlzAO1pN']);
const RECOVERY_LOG = 'C:/Users/troyh/Desktop/Faith-and-Light/code-zips/.image-rehost-recovery-2026-05-26.json';
const RESULTS_LOG = 'C:/Users/troyh/Desktop/Faith-and-Light/code-zips/.image-rehost-results-2026-05-26.json';

const FAMILIES = [
  'Redeemed Glory Edition',
  'Redeemed',
  'It Is Finished',
  'Soli Deo Gloria',
  'Faith Can Move Mountains',
  'Living Water',
  'House of Faith',
  'Walk by Faith',
  'Boho Sunburst',
  'Amen',
];

function classify(name) {
  const lower = name.toLowerCase();
  let type = 'unknown';
  if (lower.includes('tote')) type = 'tote';
  else if (lower.includes('canvas')) type = 'canvas';
  else if (lower.includes('t-shirt') || lower.includes('tee')) type = 'tee';
  // Sort by length DESC so "Redeemed Glory Edition" wins over "Redeemed"
  const sortedFamilies = [...FAMILIES].sort((a, b) => b.length - a.length);
  let family = 'unknown';
  for (const f of sortedFamilies) {
    if (name.toLowerCase().startsWith(f.toLowerCase())) { family = f; break; }
  }
  return { family, type };
}

async function listAllProducts() {
  const all = [];
  let startingAfter = null;
  do {
    const url = new URL('https://api.stripe.com/v1/products');
    url.searchParams.set('limit', '100');
    url.searchParams.set('active', 'true');
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
    if (!r.ok) throw new Error(`stripe list failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    all.push(...j.data);
    startingAfter = j.has_more ? j.data[j.data.length - 1].id : null;
  } while (startingAfter);
  return all;
}

async function snapshotToImgbb(sourceUrl, name) {
  const r = await fetch(sourceUrl);
  if (!r.ok) throw new Error(`source fetch ${sourceUrl} -> ${r.status}`);
  const contentType = r.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error(`source too small: ${buf.length} bytes`);
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: contentType }), name);
  const up = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, { method: 'POST', body: fd });
  if (!up.ok) throw new Error(`imgbb upload -> ${up.status} ${await up.text()}`);
  const j = await up.json();
  if (!j.success || !j.data || !j.data.url) throw new Error(`imgbb returned no url: ${JSON.stringify(j).slice(0,300)}`);
  return { url: j.data.url, size: buf.length, contentType };
}

async function updateStripeImage(productId, newUrl) {
  const params = new URLSearchParams();
  params.append('images[0]', newUrl);
  const r = await fetch(`https://api.stripe.com/v1/products/${productId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!r.ok) throw new Error(`stripe update ${productId} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchAndVerify(productId, expectedUrl) {
  const r = await fetch(`https://api.stripe.com/v1/products/${productId}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  if (!r.ok) throw new Error(`stripe verify ${productId} -> ${r.status}`);
  const j = await r.json();
  return j.images && j.images[0] === expectedUrl;
}

async function verifyImageServes(url) {
  const r = await fetch(url, { method: 'HEAD' });
  const ct = r.headers.get('content-type') || '';
  const cl = parseInt(r.headers.get('content-length') || '0', 10);
  return { ok: r.ok && ct.startsWith('image/') && cl > 1000, status: r.status, ct, cl };
}

async function main() {
  const onlyId = process.env.ONLY_ID || null;
  const dryRun = process.env.DRY_RUN === '1';
  console.log('Pulling products from Stripe...');
  const allProducts = await listAllProducts();
  let real = allProducts.filter((p) => !TEST_IDS.has(p.id));
  if (onlyId) real = real.filter((p) => p.id === onlyId);
  console.log(`Total active: ${allProducts.length}, processing: ${real.length}${onlyId ? ` (ONLY_ID=${onlyId})` : ''}${dryRun ? ' [DRY RUN]' : ''}`);

  let recovery = { startedAt: new Date().toISOString(), entries: {} };
  if (fs.existsSync(RECOVERY_LOG)) {
    try {
      recovery = JSON.parse(fs.readFileSync(RECOVERY_LOG, 'utf8'));
      console.log(`Loaded existing recovery log with ${Object.keys(recovery.entries).length} entries`);
    } catch {}
  }

  const results = [];
  const BATCH = 5;
  for (let i = 0; i < real.length; i += BATCH) {
    const batch = real.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    console.log(`\n=== Batch ${batchNum} (${batch.length} products) ===`);
    let batchFails = 0;
    for (const p of batch) {
      const { family, type } = classify(p.name);
      const oldUrl = p.images?.[0] || null;
      const entry = {
        productId: p.id,
        name: p.name,
        family, type,
        oldUrl,
        newUrl: null,
        status: 'pending',
        approach: null,
        error: null,
      };
      try {
        if (!oldUrl) throw new Error('product has no current image');
        if (oldUrl.includes('i.ibb.co') || oldUrl.includes('blob.vercel-storage.com')) {
          entry.status = 'already-rehosted';
          entry.newUrl = oldUrl;
          entry.approach = 'noop';
          console.log(`  SKIP ${p.id} (${family} ${type}): already permanent`);
          results.push(entry);
          recovery.entries[p.id] = entry;
          fs.writeFileSync(RECOVERY_LOG, JSON.stringify(recovery, null, 2));
          continue;
        }
        const fileName = `${family.replace(/[^a-zA-Z0-9]+/g, '-')}-${type}-${p.id}.jpg`;
        const { url: newUrl, size, contentType } = await snapshotToImgbb(oldUrl, fileName);
        entry.newUrl = newUrl;
        entry.approach = 'A-snapshot-to-imgbb';
        entry.size = size;
        entry.contentType = contentType;
        if (dryRun) {
          entry.status = 'dry-run-uploaded-not-applied';
          console.log(`  DRY  ${p.id} (${family} ${type}) ${size}b uploaded -> ${newUrl} (NOT applied to Stripe)`);
          results.push(entry);
          recovery.entries[p.id] = entry;
          fs.writeFileSync(RECOVERY_LOG, JSON.stringify(recovery, null, 2));
          continue;
        }
        await updateStripeImage(p.id, newUrl);
        const ok = await fetchAndVerify(p.id, newUrl);
        if (!ok) throw new Error('post-update verify failed: images[0] mismatch');
        entry.status = 'ok';
        console.log(`  OK   ${p.id} (${family} ${type}) ${size}b -> ${newUrl}`);
      } catch (e) {
        entry.status = 'failed';
        entry.error = String(e.message || e);
        batchFails++;
        console.log(`  FAIL ${p.id} (${family} ${type}): ${entry.error}`);
      }
      results.push(entry);
      recovery.entries[p.id] = entry;
      fs.writeFileSync(RECOVERY_LOG, JSON.stringify(recovery, null, 2));
    }
    console.log(`Batch ${batchNum}: ${batch.length - batchFails}/${batch.length} ok`);
    if (batchFails >= 2) {
      console.log(`STOP: batch ${batchNum} had ${batchFails} failures (>=2)`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  recovery.finishedAt = new Date().toISOString();
  fs.writeFileSync(RECOVERY_LOG, JSON.stringify(recovery, null, 2));
  fs.writeFileSync(RESULTS_LOG, JSON.stringify(results, null, 2));

  const okCount = results.filter((r) => r.status === 'ok' || r.status === 'already-rehosted').length;
  const failCount = results.filter((r) => r.status === 'failed').length;
  console.log(`\n=== SUMMARY === OK: ${okCount}/${results.length}  FAIL: ${failCount}`);
  console.log(`Recovery: ${RECOVERY_LOG}`);
  console.log(`Results:  ${RESULTS_LOG}`);

  // Sample render verification on first 3 ok
  if (!dryRun) {
    console.log('\n=== Sample render verification (first 3 ok) ===');
    const samples = results.filter((r) => r.status === 'ok').slice(0, 3);
    for (const s of samples) {
      const v = await verifyImageServes(s.newUrl);
      console.log(`  ${v.ok ? 'OK ' : 'BAD'} ${s.productId} status=${v.status} ct=${v.ct} cl=${v.cl}`);
    }
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
