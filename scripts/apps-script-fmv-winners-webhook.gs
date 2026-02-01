/***************************************************************************
 * FMV Winners → Google Sheets webhook
 *
 * This is the Apps Script counterpart to the Tampermonkey sheets sync.
 * Paste into Apps Script (Code.gs), save, then deploy as a Web App.
 *
 * Payload:
 * {
 *   "date": "YYYY-MM-DD",
 *   "rows": [
 *     ["t3_abc123", "winnerName", "stickerName", 5, "https://..."],
 *     ...
 *   ],
 *   "mode": "upsert" | "replace",
 *   "secret": "optional-shared-secret"
 * }
 ***************************************************************************/

const SPREADSHEET_ID = "1f2s6wF2axw4SgSyolkMfkwxcdAfWMa_X2Ik3RcaZkpk";

// Optional shared secret. Leave "" to disable.
const SHARED_SECRET = "";

const HEADER = [
  "postId",
  "winnerName",
  "stickerName",
  "stickerStars",
  "firstPostedAt",
  "postUrl",
];

function doGet() {
  return json_({ ok: true, service: "fmv-sheets-webhook", version: 1 });
}

function doPost(e) {
  try {
    const payload = safeParseJson_(e && e.postData && e.postData.contents);
    if (!payload) return json_({ ok: false, error: "bad-json" });

    if (SHARED_SECRET) {
      if (String(payload.secret || "") !== SHARED_SECRET) {
        return json_({ ok: false, error: "unauthorized" });
      }
    }

    const date = String(payload.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json_({ ok: false, error: "invalid-date", date });
    }

    const mode = payload.mode === "replace" ? "replace" : "upsert";
    const rows = normalizeRows_(payload.rows);

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ensureDaySheet_(ss, date);
    ensureHeaderAndFormat_(sheet);

    let updated = 0;
    let appended = 0;
    let cleared = 0;

    if (mode === "replace") {
      const last = sheet.getLastRow();
      if (last > 1) {
        sheet.getRange(2, 1, last - 1, HEADER.length).clearContent();
        cleared = last - 1;
      }
      if (rows.length) {
        sheet.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
        appended = rows.length;
      }
    } else {
      const last = sheet.getLastRow();
      const existing = last > 1 ? sheet.getRange(2, 1, last - 1, HEADER.length).getValues() : [];
      const index = new Map();
      for (let i = 0; i < existing.length; i++) {
        const postId = existing[i][0];
        if (postId) index.set(String(postId), i);
      }

      const toAppend = [];
      for (const row of rows) {
        const postId = row[0];
        if (!postId) continue;
        const key = String(postId);
        if (index.has(key)) {
          const existingRow = existing[index.get(key)];
          const nextRow = row.slice();
          const existingFirstPostedAt = existingRow[4];
          if (existingFirstPostedAt) {
            nextRow[4] = existingFirstPostedAt;
          }
          existing[index.get(key)] = nextRow;
          updated += 1;
        } else {
          toAppend.push(row);
        }
      }

      if (existing.length) {
        sheet.getRange(2, 1, existing.length, HEADER.length).setValues(existing);
      }
      if (toAppend.length) {
        const start = existing.length ? existing.length + 2 : 2;
        sheet.getRange(start, 1, toAppend.length, HEADER.length).setValues(toAppend);
        appended = toAppend.length;
      }
    }

    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, HEADER.length).sort([
        { column: 2, ascending: true },
        { column: 5, ascending: true },
      ]);
    }

    return json_({
      ok: true,
      tab: date,
      mode,
      received: rows.length,
      updated,
      appended,
      cleared,
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** --- helpers --- */

function safeParseJson_(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureDaySheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name, 0);
  return sheet;
}

function ensureHeaderAndFormat_(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, HEADER.length);
  const current = headerRange.getValues()[0];
  const mismatch = current.some((v, i) => String(v || "") !== HEADER[i]);
  if (mismatch) headerRange.setValues([HEADER]);

  sheet.setFrozenRows(1);
  sheet.showColumns(1, HEADER.length);
  sheet.hideColumns(1);
  sheet
    .getRange(2, 5, Math.max(sheet.getMaxRows() - 1, 1), 1)
    .setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.autoResizeColumns(1, HEADER.length);
  sheet.getRange(2, 5, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 1).setHorizontalAlignment("center");

  try {
    if (!sheet.getFilter()) {
      sheet.getRange(1, 1, sheet.getMaxRows(), HEADER.length).createFilter();
    }
  } catch (e) {
    // Ignore filter errors if it already exists.
  }
}

function normalizeRows_(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  const looksLikeUrl = (value) =>
    typeof value === "string" && value.trim().toLowerCase().startsWith("http");
  const looksLikeUserId = (value) =>
    typeof value === "string" && value.trim().toLowerCase().startsWith("t2_");

  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const postId = String(r[0] || "").trim();
    if (!postId) continue;

    let winnerName = "";
    let stickerName = "";
    let stickerStars = "";
    let updatedAt = "";
    let postUrl = "";

    if (r.length >= 6 && looksLikeUrl(r[5]) && looksLikeUserId(r[1])) {
      // Legacy payload with winnerId present (postId, winnerId, winnerName, stickerName, stars, postUrl)
      winnerName = r[2];
      stickerName = r[3];
      stickerStars = r[4];
      postUrl = r[5];
    } else if (r.length >= 6 && looksLikeUrl(r[5])) {
      // Current payload with updatedAt in slot 5
      winnerName = r[1];
      stickerName = r[2];
      stickerStars = r[3];
      updatedAt = r[4];
      postUrl = r[5];
    } else if (r.length >= 5 && looksLikeUrl(r[4])) {
      // Legacy payload without updatedAt
      winnerName = r[1];
      stickerName = r[2];
      stickerStars = r[3];
      postUrl = r[4];
    } else {
      const row = r.slice(0, HEADER.length);
      while (row.length < HEADER.length) row.push("");
      winnerName = row[1];
      stickerName = row[2];
      stickerStars = row[3];
      updatedAt = row[4];
      postUrl = row[5] || row[4] || "";
    }

    postUrl = String(postUrl || "").trim();
    if (!postId || !postUrl) continue;
    if (seen.has(postId)) continue;
    seen.add(postId);

    const n = Number(stickerStars);
    const starsValue = Number.isFinite(n) ? n : "";
    let updatedValue = updatedAt;
    if (!updatedValue) {
      updatedValue = new Date();
    } else if (!(updatedValue instanceof Date)) {
      const parsed = new Date(updatedValue);
      updatedValue = isNaN(parsed.getTime()) ? new Date() : parsed;
    }

    out.push([
      postId,
      winnerName != null ? String(winnerName).trim() : "",
      stickerName != null ? String(stickerName).trim() : "",
      starsValue,
      updatedValue,
      postUrl,
    ]);
  }

  return out;
}
