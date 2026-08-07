/**
 * PushToScribe.gs — Google Apps Script web app.
 *
 * Purpose: receive a POST { title, content } from the MCP tool `push_to_scribe`
 * (see thinkinbuddy/api/mcp.js, function pushToScribe()), create a new Google Doc in
 * the deploying user's Google Drive, write `content` into the doc body, and
 * return JSON { url: <doc url> } so mcp.js can hand the link back to Claude.ai.
 *
 * This file is NOT executable by Vercel or Node — Apps Script only runs inside
 * Google's own environment (script.google.com). It is committed here purely
 * for version control / code review. To actually run it, a human with a
 * Google account must paste it into script.google.com and deploy it as a web
 * app. See thinkinbuddy/scribe/DEPLOY_INSTRUCTIONS.md for the exact steps — that
 * part cannot be done by Claude Code; it requires interactive Google OAuth
 * consent from a real Google account.
 *
 * Contract expected by thinkinbuddy/api/mcp.js pushToScribe():
 *   Request:  POST body = JSON { title: string, content: string }
 *   Response: JSON { url: string }                          on success
 *             HTTP 400-equivalent JSON { error: string }    on bad input
 *             HTTP 500-equivalent JSON { error: string }    on unexpected failure
 *
 * NOTE on Apps Script + HTTP status codes: ContentService responses from a
 * Web App always return HTTP 200 to the caller (Apps Script does not let you
 * set an arbitrary status code on doPost). mcp.js only checks `res.ok` (true
 * for any 2xx) and then inspects the JSON body, so we signal errors via the
 * JSON payload itself: an `error` key means failure, a `url` key means
 * success. This function makes that contract explicit rather than silently
 * returning 200 with an ambiguous body.
 */

function doPost(e) {
  var responseObj;

  try {
    if (!e || !e.postData || !e.postData.contents) {
      responseObj = { error: 'No request body received' };
      return jsonResponse(responseObj);
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      responseObj = { error: 'Request body was not valid JSON' };
      return jsonResponse(responseObj);
    }

    var title = payload.title;
    var content = payload.content;

    // 400-equivalent: missing required fields.
    if (!title || typeof title !== 'string' || !title.trim()) {
      responseObj = { error: 'Missing required field: title' };
      return jsonResponse(responseObj);
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      responseObj = { error: 'Missing required field: content' };
      return jsonResponse(responseObj);
    }

    // Create the Doc and write the content into the body.
    var doc = DocumentApp.create(title);
    var body = doc.getBody();
    body.setText(content);
    doc.saveAndClose();

    var url = doc.getUrl();

    responseObj = { url: url };
    return jsonResponse(responseObj);

  } catch (err) {
    // 500-equivalent: anything unexpected (e.g. Drive quota, DocumentApp failure).
    responseObj = { error: 'Apps Script error: ' + (err && err.message ? err.message : String(err)) };
    return jsonResponse(responseObj);
  }
}

/**
 * Optional: lets you sanity-check the deployed web app URL in a browser
 * (GET request) without sending a POST. Visiting the /exec URL directly
 * will hit this instead of doPost.
 */
function doGet(e) {
  return jsonResponse({ ok: true, server: 'push-to-scribe', note: 'POST { title, content } to create a Google Doc.' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
