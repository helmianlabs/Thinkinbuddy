// api/actionable.js
// ---------------------------------------------------------------------------
// Actionable — capture endpoint. POST voice and/or a photo, get a structured
// entry, a Google Doc, and a searchable indexed record.
//
// ADDITIVE. api/diary.js is untouched and still serves the existing PWA at
// thinkinbuddy.vercel.app/diary.html, whose blueprint is a product Troy sells.
// Nothing in this file imports from it or changes its behaviour.
//
// POST body:
//   {
//     userId:      "troy",                    // required
//     text?:       "typed instead of spoken",
//     audioBase64?, mimeType?,                // voice
//     imageBase64?, imageMime?,               // photo (always attached, auto-OCR'd)
//     capturedAt?: ISO string,                // when it was SPOKEN, not received
//     timezone?:   "America/Denver",
//     source?:     "app" | "web"
//   }
//
// ORDER OF OPERATIONS IS DELIBERATE: transcribe → extract → SAVE TO POSTGRES →
// then write the Doc. The database write is what makes the capture durable, so
// it happens before any third-party call that can fail. A Docs outage degrades
// this to "saved but not yet written to Docs", never to lost audio.
// ---------------------------------------------------------------------------

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };

import { transcribeAudio, extractEntry, searchableText, isVisionMime } from '../lib/actionable/extract.js';
import {
  listProjects, ensureSeedProjects, listKnownTags, listKnownPeople,
  getSettings, saveEntry, attachOutputs,
} from '../lib/actionable/db.js';
import {
  writeGoogleDoc, writeDocViaWebhook, shouldAlsoLogToSheet,
  appendToSheet, appendToSheetWebhook,
} from '../lib/actionable/docs.js';
import { googleStatus } from '../lib/actionable/google-auth.js';
import { requireAuth, cors } from '../lib/actionable/http.js';
import { resolveChain } from '../lib/actionable/providers.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  const OPENAI_KEY = process.env.OPENAI_API_KEY;

  // Structuring is vendor-agnostic (lib/actionable/providers.js). Any ONE of
  // OpenAI / Gemini / Anthropic being configured is enough; the chain falls
  // through to the next when one is down or out of credit. Refusing here only
  // when NOTHING is configured is what stopped a single vendor's billing
  // problem from taking every capture down.
  const chain = resolveChain();
  if (!chain.length) {
    return res.status(500).json({
      error: 'No extraction provider configured — set OPENAI_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY.',
    });
  }

  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const {
    text, audioBase64, mimeType,
    imageBase64, imageMime,
    capturedAt, timezone: tzIn, source = 'app',
  } = req.body || {};

  const warnings = [];

  try {
    await ensureSeedProjects(userId);
    const settings = await getSettings(userId);
    const timezone = tzIn || settings.timezone || 'America/Denver';

    // ---- 1. Transcribe -----------------------------------------------------
    let transcript = typeof text === 'string' ? text.trim() : '';
    if (!transcript && audioBase64) {
      if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY needed for audio' });
      transcript = (await transcribeAudio(audioBase64, mimeType || 'audio/webm', OPENAI_KEY)).trim();
    }

    const hasUsableImage = Boolean(imageBase64 && isVisionMime(imageMime));
    if (imageBase64 && !hasUsableImage) {
      warnings.push(`Image type ${imageMime || 'unknown'} cannot be read for text — it is stored but not OCR'd.`);
    }

    // A capture with neither words nor a readable photo has nothing to work on.
    if ((!transcript || transcript.length < 3) && !hasUsableImage) {
      return res.status(400).json({ error: 'Nothing to save — no speech detected and no readable photo.' });
    }

    // ---- 2. Extract --------------------------------------------------------
    const [projects, tags, people] = await Promise.all([
      listProjects(userId), listKnownTags(userId), listKnownPeople(userId),
    ]);

    const entry = await extractEntry({
      transcript,
      imageBase64: hasUsableImage ? imageBase64 : null,
      imageMime: hasUsableImage ? imageMime : null,
      projects, tags, people,
      nowIso: capturedAt || new Date().toISOString(),
      timezone,
    });

    // A silent downgrade to a fallback vendor would otherwise look like the
    // model quietly got worse. Say it in the response.
    if (entry.provider_fallbacks?.length) {
      warnings.push(
        `Structured by ${entry.extracted_by.provider} (${entry.extracted_by.model}) after ` +
        `${entry.provider_fallbacks.length} provider(s) failed: ${entry.provider_fallbacks.join('; ')}`
      );
    }

    // ---- 3. Store the photo (best effort) ----------------------------------
    let imageUrl = null;
    if (imageBase64) {
      try {
        imageUrl = await storeImage(imageBase64, imageMime, userId);
      } catch (e) {
        // The OCR'd text and description are already in `entry`, so the photo's
        // CONTENT survives even when the binary does not.
        console.error('[actionable] image upload failed:', e?.message || e);
        warnings.push('Photo could not be uploaded to storage — its text was still read and indexed.');
      }
    }

    // ---- 4. Save — the durable step ---------------------------------------
    const saved = await saveEntry({
      userId, entry, transcript,
      searchText: searchableText(entry, transcript),
      imageUrl, imageMime: imageMime || null,
      capturedAt: capturedAt || null,
      timezone, source,
    });

    // ---- 5. Google Docs ----------------------------------------------------
    let doc = { ok: false, reason: 'not_configured' };
    const gstatus = await googleStatus(userId);
    const renderOpts = { transcript, capturedAt: saved.capturedAt, timezone, projects };

    try {
      if (gstatus.connected) {
        doc = await writeGoogleDoc(userId, entry, { ...renderOpts, folderId: settings.doc_folder_id });
      } else if (settings.docs_webhook) {
        doc = await writeDocViaWebhook(settings.docs_webhook, entry, renderOpts);
      } else if (process.env.DOCS_ACTIONABLE_WEBHOOK) {
        doc = await writeDocViaWebhook(process.env.DOCS_ACTIONABLE_WEBHOOK, entry, renderOpts);
      }
    } catch (e) {
      console.error('[actionable] doc write failed:', e?.message || e);
      warnings.push(`Saved, but the Google Doc could not be written: ${e.message}`);
      doc = { ok: false, reason: 'error', error: e.message };
    }

    // ---- 6. Sheets — optional, numeric entries only -------------------------
    let sheet = { ok: false, reason: 'not_applicable' };
    if (shouldAlsoLogToSheet(entry, settings.numeric_threshold)) {
      try {
        if (gstatus.connected && settings.sheet_id) {
          sheet = await appendToSheet(userId, entry, { sheetId: settings.sheet_id, capturedAt: saved.capturedAt });
        } else if (settings.sheets_webhook || process.env.SHEETS_DIARY_WEBHOOK) {
          sheet = await appendToSheetWebhook(
            settings.sheets_webhook || process.env.SHEETS_DIARY_WEBHOOK,
            entry, { capturedAt: saved.capturedAt, transcript }
          );
        } else {
          sheet = { ok: false, reason: 'numbers_found_but_no_sheet_configured' };
        }
      } catch (e) {
        console.error('[actionable] sheet append failed:', e?.message || e);
        warnings.push(`Numbers were found but the spreadsheet write failed: ${e.message}`);
      }
    }

    if (doc.ok || sheet.ok) {
      await attachOutputs(saved.id, {
        docUrl: doc.url || null,
        docId: doc.documentId || null,
        sheetOk: sheet.ok || null,
      });
    }

    // Actions the PHONE must perform. The server cannot set an alarm; it tells
    // the app precisely what to schedule and the app asks for permission.
    const phoneActions = entry.items
      .map((it, i) => ({ ...it.phone_action, itemIndex: i, itemText: it.text }))
      .filter(a => a.kind !== 'none');

    return res.status(200).json({
      ok: true,
      entryId: saved.id,
      capturedAt: saved.capturedAt,
      transcript,
      entry,
      phoneActions,
      doc: { written: !!doc.ok, url: doc.url || null, reason: doc.reason || null },
      sheet: { written: !!sheet.ok, reason: sheet.reason || null },
      imageUrl,
      warnings,
    });

  } catch (err) {
    console.error('[actionable]', err);
    return res.status(500).json({ error: err.message, warnings });
  }
}

// ---------------------------------------------------------------------------
// storeImage — Vercel Blob, which this project already depends on
// (package.json: "@vercel/blob"). Imported lazily so a deployment without
// BLOB_READ_WRITE_TOKEN still serves every non-photo capture instead of failing
// at module load.
// ---------------------------------------------------------------------------
async function storeImage(base64, mime, userId) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN not set');
  }
  const { put } = await import('@vercel/blob');
  const buf = Buffer.from(base64, 'base64');
  const ext = (String(mime || 'image/jpeg').split('/')[1] || 'jpg').split(';')[0];
  const key = `actionable/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { url } = await put(key, buf, {
    access: 'public',
    contentType: mime || 'image/jpeg',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return url;
}
