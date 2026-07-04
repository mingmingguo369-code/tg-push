// ============================================================
// Telegram 頻道圖文推播工具 — 後端
// 只用 express，圖片走 base64，後端拿 token 呼叫 Telegram API
// ============================================================

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PANEL_PASSWORD = process.env.PANEL_PASSWORD || ""; // 沒設就不檢查
const TG = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

const fs = require("fs");
const CONFIG_FILE = path.join(__dirname, "saved-config.json");

function checkPassword(req, res) {
  if (!PANEL_PASSWORD) return true;
  if (req.body && req.body.password === PANEL_PASSWORD) return true;
  res.status(401).json({ ok: false, error: "密碼錯誤" });
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 雲端設定：存到伺服器，任何電腦打開都同一份 ----
app.post("/api/save-config", (req, res) => {
  if (!checkPassword(req, res)) return;
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body.config || {}), "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

app.post("/api/load-config", (req, res) => {
  if (!checkPassword(req, res)) return;
  try {
    if (!fs.existsSync(CONFIG_FILE)) return res.json({ ok: true, config: null });
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    res.json({ ok: true, config: data });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// ---- 驗證 bot：回傳 bot 名稱 ----
app.post("/api/verify", async (req, res) => {
  if (!checkPassword(req, res)) return;
  const { token } = req.body;
  if (!token) return res.json({ ok: false, error: "沒填 token" });
  try {
    const r = await fetch(TG(token, "getMe"));
    const data = await r.json();
    if (!data.ok) return res.json({ ok: false, error: data.description });
    res.json({
      ok: true,
      username: data.result.username,
      name: data.result.first_name,
    });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// 把按鈕網址補成合法 URL：@帳號 / t.me/xxx → https://t.me/xxx
function normalizeUrl(u) {
  if (!u) return u;
  u = u.trim();
  if (u.startsWith("@")) return "https://t.me/" + u.slice(1);
  if (/^t\.me\//i.test(u)) return "https://" + u;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^tg:\/\//i.test(u)) return u; // 允許 tg:// 深連結
  // 其他看起來像網域的，補 https://
  if (/^[\w.-]+\.[a-z]{2,}/i.test(u)) return "https://" + u;
  return u;
}

// ---- 收集 ID：讀取與 bot 互動過的帳號 ----
app.post("/api/collect-ids", async (req, res) => {
  if (!checkPassword(req, res)) return;
  const { token } = req.body;
  if (!token) return res.json({ ok: false, error: "沒填 token" });
  try {
    const r = await fetch(TG(token, "getUpdates") + "?limit=100");
    const data = await r.json();
    if (!data.ok) return res.json({ ok: false, error: data.description });
    const map = new Map();
    for (const u of data.result) {
      const from =
        (u.message && u.message.from) ||
        (u.edited_message && u.edited_message.from) ||
        (u.callback_query && u.callback_query.from);
      if (from && !from.is_bot) {
        map.set(from.id, {
          id: from.id,
          username: from.username || "",
          name: [from.first_name, from.last_name].filter(Boolean).join(" "),
        });
      }
    }
    res.json({ ok: true, users: [...map.values()] });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// ---- 收集自訂表情：讀取互動訊息裡的 custom_emoji，抓回真實表情圖 ----
// token 只在後端使用，不外洩到前端
app.post("/api/collect-emojis", async (req, res) => {
  if (!checkPassword(req, res)) return;
  const { token } = req.body;
  if (!token) return res.json({ ok: false, error: "沒填 token" });
  try {
    const r = await fetch(TG(token, "getUpdates") + "?limit=100");
    const data = await r.json();
    if (!data.ok) return res.json({ ok: false, error: data.description });

    // 1) 掃各訊息的 entities / caption_entities，取 custom_emoji（用 Map 依 id 去重）
    const map = new Map(); // custom_emoji_id -> 備援 emoji 字元
    for (const u of data.result) {
      const msg =
        u.message || u.edited_message || u.channel_post || u.edited_channel_post;
      if (!msg) continue;
      const text = msg.text || msg.caption || "";
      const ents = msg.entities || msg.caption_entities || [];
      for (const e of ents) {
        if (e.type === "custom_emoji" && e.custom_emoji_id) {
          if (!map.has(e.custom_emoji_id)) {
            const fallback = text.slice(e.offset, e.offset + e.length);
            map.set(e.custom_emoji_id, fallback);
          }
        }
      }
    }
    const ids = [...map.keys()];
    if (!ids.length) return res.json({ ok: true, emojis: [] });

    // 2) 取每顆貼圖的 file_id / 型別（getCustomEmojiStickers 一次上限 200 顆）
    const stickers = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const sr = await fetch(
        TG(token, "getCustomEmojiStickers") +
          "?custom_emoji_ids=" +
          encodeURIComponent(JSON.stringify(batch))
      );
      const sd = await sr.json();
      if (sd.ok && Array.isArray(sd.result)) stickers.push(...sd.result);
    }

    // 3) 逐顆 getFile 取 file_path，下載檔案轉 base64 data URL
    const emojis = [];
    for (const s of stickers) {
      const id = s.custom_emoji_id;
      const emojiChar = s.custom_emoji || map.get(id) || "";
      // 依格式決定 mime 與前端渲染型別
      let kind = "img", mime = "image/webp";
      if (s.is_video) { kind = "video"; mime = "video/webm"; }
      else if (s.is_animated) { kind = "tgs"; mime = "application/gzip"; }
      try {
        const fr = await fetch(
          TG(token, "getFile") + "?file_id=" + encodeURIComponent(s.file_id)
        );
        const fd = await fr.json();
        if (!fd.ok || !fd.result || !fd.result.file_path) continue;
        const dl = await fetch(
          `https://api.telegram.org/file/bot${token}/${fd.result.file_path}`
        );
        const buf = Buffer.from(await dl.arrayBuffer());
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        emojis.push({ id, emoji: emojiChar, dataUrl, kind });
      } catch (e) {
        // 單顆下載失敗就跳過
      }
    }
    res.json({ ok: true, emojis });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// ---- 從 TG 訊息重建成 Telegram HTML（含自訂表情、粗體等）----
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
// 依 entity 型別回傳 [開標籤, 閉標籤]；不支援的型別回 null（當純文字）
function tagsForEntity(e) {
  switch (e.type) {
    case "bold": return ["<b>", "</b>"];
    case "italic": return ["<i>", "</i>"];
    case "underline": return ["<u>", "</u>"];
    case "strikethrough": return ["<s>", "</s>"];
    case "code": return ["<code>", "</code>"];
    case "pre": return ["<pre>", "</pre>"];
    case "text_link": return [`<a href="${escapeAttr(e.url || "")}">`, "</a>"];
    case "custom_emoji": return [`<tg-emoji emoji-id="${escapeAttr(e.custom_emoji_id || "")}">`, "</tg-emoji>"];
    default: return null; // mention / url / hashtag 等 → 保留純文字即可
  }
}
// entity 的 offset/length 是 UTF-16 code unit，JS 字串本身就是 UTF-16，直接用 index 對應。
// 用「邊界切段」法：在每個 entity 的起訖點切開，段內文字用當下作用中的標籤包起來，確保巢狀正確。
function entitiesToHtml(text, entities) {
  const ents = (entities || []).filter((e) => tagsForEntity(e) !== null);
  const len = text.length;
  if (!ents.length) return escapeHtml(text);

  const bounds = new Set([0, len]);
  for (const e of ents) {
    bounds.add(e.offset);
    bounds.add(e.offset + e.length);
  }
  const points = [...bounds].filter((b) => b >= 0 && b <= len).sort((a, b) => a - b);

  let out = "";
  for (let k = 0; k < points.length - 1; k++) {
    const start = points[k], end = points[k + 1];
    if (end <= start) continue;
    const seg = text.substring(start, end);
    // 找出完整涵蓋這一段的 entity；外層(長的)先開、後關
    const active = ents
      .filter((e) => e.offset <= start && e.offset + e.length >= end)
      .sort((a, b) => b.length - a.length || a.offset - b.offset);
    let open = "", close = "";
    for (const e of active) {
      const [o, c] = tagsForEntity(e);
      open += o;
      close = c + close;
    }
    out += open + escapeHtml(seg) + close;
  }
  return out;
}

// ---- 從 bot 收到的最後一則訊息，還原成 caption（HTML）----
app.post("/api/import-message", async (req, res) => {
  if (!checkPassword(req, res)) return;
  const { token } = req.body;
  if (!token) return res.json({ ok: false, error: "沒填 token" });
  try {
    const r = await fetch(TG(token, "getUpdates") + "?limit=100");
    const data = await r.json();
    if (!data.ok) return res.json({ ok: false, error: data.description });
    // 取最後一則有 text 或 caption 的訊息（使用者轉發/傳給 bot 的）
    let picked = null;
    for (const u of data.result) {
      const m =
        u.message || u.edited_message || u.channel_post || u.edited_channel_post;
      if (!m) continue;
      if ((m.text && m.text.length) || (m.caption && m.caption.length) ||
          (m.photo && m.photo.length) || m.video || m.animation) picked = m;
    }
    if (!picked) {
      return res.json({
        ok: false,
        error: "沒有找到含文字的訊息。請先把你在 TG 編排好的訊息「轉發」或直接傳給這支 bot，再按一次匯入。",
      });
    }
    const hasText = picked.text != null;
    const text = hasText ? picked.text : picked.caption;
    const entities = hasText ? picked.entities : picked.caption_entities;
    const html = entitiesToHtml(text || "", entities || []);

    // 附帶媒體：photo(取最大尺寸) / video / animation(GIF)
    let mediaDataUrl = "", mediaType = "image", fileId = "";
    if (picked.photo && picked.photo.length) {
      fileId = picked.photo[picked.photo.length - 1].file_id; // 最大尺寸那張
      mediaType = "image";
    } else if (picked.video) {
      fileId = picked.video.file_id;
      mediaType = "video";
    } else if (picked.animation) {
      fileId = picked.animation.file_id;
      mediaType = "gif";
    }
    if (fileId) {
      try {
        const fr = await fetch(TG(token, "getFile") + "?file_id=" + encodeURIComponent(fileId));
        const fd = await fr.json();
        if (fd.ok && fd.result && fd.result.file_path) {
          const fp = fd.result.file_path;
          const dl = await fetch(`https://api.telegram.org/file/bot${token}/${fp}`);
          const buf = Buffer.from(await dl.arrayBuffer());
          let mime;
          if (mediaType === "video" || mediaType === "gif") {
            mime = "video/mp4"; // Telegram 影片/GIF(animation) 實際皆為 mp4
          } else if (/\.png$/i.test(fp)) mime = "image/png";
          else if (/\.webp$/i.test(fp)) mime = "image/webp";
          else mime = "image/jpeg";
          mediaDataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        }
      } catch (e) {
        mediaDataUrl = ""; // 媒體下載失敗就只匯文案
      }
    }
    res.json({ ok: true, html, mediaDataUrl, mediaType });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// ---- 把一則貼文發到一個頻道 ----
async function sendOne(token, channel, post) {
  const buttons = (post.buttons || [])
    .map((row) => row.map((b) => ({ text: b.text, url: normalizeUrl(b.url) })))
    .filter((row) => row.length && row.some((b) => b.text && b.url));
  const reply_markup =
    buttons.length > 0 ? JSON.stringify({ inline_keyboard: buttons }) : undefined;

  let result;
  if (post.imageBase64) {
    // 依媒體型別決定發送方式
    const base64 = post.imageBase64.split(",").pop();
    const buffer = Buffer.from(base64, "base64");
    const mt = post.mediaType || "image";
    let method = "sendPhoto", field = "photo", fname = post.fileName || "photo.jpg";
    if (mt === "video") { method = "sendVideo"; field = "video"; fname = post.fileName || "video.mp4"; }
    else if (mt === "gif") { method = "sendAnimation"; field = "animation"; fname = post.fileName || "anim.gif"; }

    const form = new FormData();
    form.append("chat_id", channel);
    if (post.caption) form.append("caption", post.caption);
    form.append("parse_mode", "HTML");
    if (reply_markup) form.append("reply_markup", reply_markup);
    form.append(field, new Blob([buffer]), fname);

    const r = await fetch(TG(token, method), { method: "POST", body: form });
    result = await r.json();
  } else {
    // 沒圖 → sendMessage
    const body = {
      chat_id: channel,
      text: post.caption || "(無內容)",
      parse_mode: "HTML",
    };
    if (reply_markup) body.reply_markup = JSON.parse(reply_markup);
    const r = await fetch(TG(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    result = await r.json();
  }

  // 置頂
  if (result.ok && post.pin && result.result && result.result.message_id) {
    await fetch(TG(token, "pinChatMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channel,
        message_id: result.result.message_id,
        disable_notification: true,
      }),
    });
  }

  return result;
}

// ---- 發送全部：多則貼文 × 多頻道 ----
app.post("/api/send", async (req, res) => {
  if (!checkPassword(req, res)) return;
  const { channels, posts } = req.body;
  // 多支 bot：[{ token, quota }]，配額 = 發幾則就換下一支
  const bots = (req.body.bots || []).filter((b) => b.token);
  const intervalMs = Math.max(0, Number(req.body.interval) || 1) * 1000;
  // 總配額：自動平均分給每支機器人 → 每支連續發 chunk 則就換下一支
  const totalQuota = Math.max(1, Number(req.body.totalQuota) || bots.length);
  const chunk = Math.max(1, Math.ceil(totalQuota / (bots.length || 1)));

  if (!bots.length) return res.json({ ok: false, error: "沒有任何機器人" });
  if (!channels || !channels.length)
    return res.json({ ok: false, error: "沒填頻道" });
  if (!posts || !posts.length)
    return res.json({ ok: false, error: "沒有任何貼文" });

  // 把所有要發的工作攤平成清單（每則貼文 × 每個頻道）
  const jobs = [];
  for (let pi = 0; pi < posts.length; pi++)
    for (const channel of channels) jobs.push({ pi, channel, post: posts[pi] });

  // 配額輪替的指標（每支連續發 chunk 則就換下一支）
  let botIdx = 0;
  let usedInBot = 0;
  function pickBot() {
    const bot = bots[botIdx];
    usedInBot++;
    if (usedInBot >= chunk) {
      usedInBot = 0;
      botIdx = (botIdx + 1) % bots.length; // 輪完從頭
    }
    return bot;
  }

  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const bot = pickBot();
    try {
      const r = await sendOne(bot.token, job.channel, job.post);
      results.push({
        post: job.pi + 1,
        channel: job.channel,
        bot: bot.name || "機器人",
        ok: !!r.ok,
        error: r.ok ? null : r.description,
      });
    } catch (e) {
      results.push({ post: job.pi + 1, channel: job.channel, bot: bot.name || "機器人", ok: false, error: String(e) });
    }
    // 每次發送之間都等使用者選的間隔（私發大量會員時才不會被限流）
    const isLast = i === jobs.length - 1;
    if (!isLast) await sleep(intervalMs);
  }

  const allOk = results.every((x) => x.ok);
  res.json({ ok: allOk, results });
});

const PORT = process.env.PORT || 3000;

// 任何未匹配路徑都回面板首頁（避免 Not Found）
app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`✅ 工具已啟動，連到 http://localhost:${PORT}`));
