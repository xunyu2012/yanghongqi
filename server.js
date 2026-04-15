'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'app.db');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'xunyu-dev-change-me-in-production';
/** 登录 Cookie 最长保留（毫秒）。默认 400 天（接近常见浏览器上限）；可用 SESSION_MAX_AGE_MS 覆盖。rolling 在每次请求时顺延过期。 */
const SESSION_COOKIE_MAX_MS = (() => {
  const cap = 400 * 24 * 60 * 60 * 1000;
  const raw = String(process.env.SESSION_MAX_AGE_MS || '').trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 5 * 60 * 1000), cap);
  }
  return cap;
})();

/** Nano Banana 上游单次请求超时（毫秒）。4K+多分镜耗时长；可用 NANO_BANANA_FETCH_TIMEOUT_MS 覆盖（60000～900000）。 */
const NANO_BANANA_FETCH_TIMEOUT_MS = (() => {
  const raw = String(process.env.NANO_BANANA_FETCH_TIMEOUT_MS || '').trim();
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 60000 && n <= 900000) return n;
  return 300000;
})();

/** Node 单请求 socket 超时（毫秒），应 ≥ 上游图片超时，并与 Nginx proxy_read_timeout 对齐。可用 HTTP_SERVER_REQUEST_TIMEOUT_MS（120000～1200000）。 */
function resolveHttpServerRequestTimeoutMs() {
  const raw = String(process.env.HTTP_SERVER_REQUEST_TIMEOUT_MS || '').trim();
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 120000 && n <= 1200000) return n;
  return Math.max(600000, NANO_BANANA_FETCH_TIMEOUT_MS + 120000);
}

const COST = {
  script: 1,
  prompt: 1,
  shotSuggest: 1,
  image: 2,
  text_to_video: 50,
  image_to_video: 50,
  video_analysis: 5,
};

function ensureDirs() {
  [DATA_DIR, UPLOAD_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function initDb() {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS consumption_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      cost INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('api_config');
  if (!row) {
    const defaultConfig = {
      llm: {
        provider: 'openai-compatible',
        model: 'astron-code-latest',
        key: '',
        endpoint: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2/v1/chat/completions',
      },
      llm2: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        key: '',
        endpoint: '',
      },
      image: {
        provider: 'mock',
        key: '',
        baseUrl: 'https://banana.aigenmedia.art',
        model: '',
        defaultAspect: '1:1',
        defaultResolution: '1K',
        geminiModel: 'gemini-3-pro-image-preview',
        geminiAspect: '1:1',
        geminiImageSize: '1K',
      },
      video: {
        provider: 'mock',
        key: '',
        baseUrl: 'https://app-api.pixverseai.cn',
        model: 'c1',
        quality: '720p',
        img2vidPreviewQuality: '360p',
        img2vidFinalQuality: '1080p',
        aspectRatio: '16:9',
        motionMode: 'normal',
        negativePrompt: '',
        seed: null,
        waterMark: false,
        soundEffectSwitch: false,
        soundEffectContent: '',
      },
      analyze: {
        provider: 'dashscope',
        key: '',
        openaiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        endpoint: '',
        model: 'qwen3-vl-plus',
      },
    };
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'api_config',
      JSON.stringify(defaultConfig)
    );
  }
  const adminRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_user');
  if (!adminRow) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'admin_user',
      JSON.stringify({ username: 'admin', password_hash: hash })
    );
  }
  const ucsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('upload_cache_settings');
  if (!ucsRow) {
    let retentionHours = 8;
    let intervalMinutes = 30;
    const eH = String(process.env.UPLOAD_CACHE_RETENTION_HOURS || '').trim();
    if (eH === '0' || /^false$/i.test(eH)) retentionHours = 0;
    else {
      const h = Number(eH);
      if (Number.isFinite(h) && h > 0) retentionHours = Math.min(720, h);
    }
    const eI = String(process.env.UPLOAD_CACHE_CLEAN_INTERVAL_MINUTES || '').trim();
    if (eI !== '') {
      const m = Number(eI);
      if (Number.isFinite(m) && m > 0) intervalMinutes = Math.min(1440, Math.round(m));
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'upload_cache_settings',
      JSON.stringify({ retentionHours, intervalMinutes })
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS director_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS director_user_actor_library (
      user_id INTEGER PRIMARY KEY,
      actors_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS director_user_assets_library (
      user_id INTEGER PRIMARY KEY,
      assets_json TEXT NOT NULL DEFAULT '{"actors":[],"scenes":[],"props":[],"panoScenes":[]}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  migrateDirectorSeriesSchema(db);
  return db;
}

function migrateDirectorSeriesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS director_series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  const colNames = new Set(
    db.prepare('PRAGMA table_info(director_projects)').all().map((c) => c.name)
  );
  if (!colNames.has('series_id')) {
    db.exec('ALTER TABLE director_projects ADD COLUMN series_id INTEGER;');
  }
}

const db = initDb();

const UPLOAD_CACHE_DEFAULT = { retentionHours: 8, intervalMinutes: 30 };

function normalizeUploadCachePayload(j) {
  let retentionHours = UPLOAD_CACHE_DEFAULT.retentionHours;
  let intervalMinutes = UPLOAD_CACHE_DEFAULT.intervalMinutes;
  if (j && typeof j === 'object') {
    if (typeof j.retentionHours === 'number' && Number.isFinite(j.retentionHours)) {
      retentionHours = j.retentionHours;
    }
    if (typeof j.intervalMinutes === 'number' && Number.isFinite(j.intervalMinutes)) {
      intervalMinutes = j.intervalMinutes;
    }
  }
  retentionHours = Math.max(0, Math.min(720, retentionHours));
  intervalMinutes = Math.max(1, Math.min(1440, Math.round(intervalMinutes)));
  return {
    retentionHours,
    intervalMinutes,
    retentionMs: retentionHours > 0 ? retentionHours * 3600000 : 0,
    intervalMs: intervalMinutes * 60000,
  };
}

function getUploadCacheSettings() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('upload_cache_settings');
    if (row?.value) return normalizeUploadCachePayload(JSON.parse(row.value));
  } catch {}
  return normalizeUploadCachePayload(UPLOAD_CACHE_DEFAULT);
}

function saveUploadCacheSettings(body) {
  const cur = getUploadCacheSettings();
  let retentionHours = cur.retentionHours;
  let intervalMinutes = cur.intervalMinutes;
  if (body && body.retentionHours != null) {
    const n = Number(body.retentionHours);
    if (Number.isFinite(n)) retentionHours = n;
  }
  if (body && body.intervalMinutes != null) {
    const n = Number(body.intervalMinutes);
    if (Number.isFinite(n)) intervalMinutes = n;
  }
  const norm = normalizeUploadCachePayload({ retentionHours, intervalMinutes });
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'upload_cache_settings',
    JSON.stringify({
      retentionHours: norm.retentionHours,
      intervalMinutes: norm.intervalMinutes,
    })
  );
  return getUploadCacheSettings();
}

let uploadCacheBootTimer = null;
let uploadCacheIntervalHandle = null;

function stopUploadCacheScheduler() {
  if (uploadCacheBootTimer) {
    clearTimeout(uploadCacheBootTimer);
    uploadCacheBootTimer = null;
  }
  if (uploadCacheIntervalHandle) {
    clearInterval(uploadCacheIntervalHandle);
    uploadCacheIntervalHandle = null;
  }
}

function startUploadCacheScheduler() {
  stopUploadCacheScheduler();
  const cfg = getUploadCacheSettings();
  if (!cfg.retentionMs) {
    console.log('[upload-cache] 自动清理已关闭（保留时长为 0 小时）');
    return;
  }
  console.log(
    `[upload-cache] uploads/ 超过约 ${cfg.retentionHours} 小时（按文件修改时间）删除；扫描间隔 ${cfg.intervalMinutes} 分钟`
  );
  uploadCacheBootTimer = setTimeout(() => {
    uploadCacheBootTimer = null;
    cleanExpiredUploadCache();
    uploadCacheIntervalHandle = setInterval(cleanExpiredUploadCache, cfg.intervalMs);
  }, 60 * 1000);
}

async function cleanExpiredUploadCache() {
  const { retentionMs } = getUploadCacheSettings();
  if (!retentionMs) return;
  const now = Date.now();
  let removed = 0;
  let failed = 0;
  try {
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
    const names = await fs.promises.readdir(UPLOAD_DIR);
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const fp = path.join(UPLOAD_DIR, name);
      let st;
      try {
        st = await fs.promises.stat(fp);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs <= retentionMs) continue;
      try {
        await fs.promises.unlink(fp);
        removed++;
      } catch (e) {
        failed++;
        console.warn('[upload-cache]', name, e.message);
      }
    }
    if (removed || failed) {
      console.log(
        `[upload-cache] 已清理 ${removed} 个过期文件（>${(retentionMs / 3600000).toFixed(1)}h）` +
          (failed ? `，${failed} 个删除失败` : '')
      );
    }
  } catch (e) {
    console.warn('[upload-cache] 扫描失败:', e.message);
  }
}

function ok(data) {
  return { code: 200, data };
}

function fail(msg, code = 400) {
  return { code, msg: msg || '错误' };
}

function getApiConfig() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('api_config');
    if (!row?.value) return {};
    return JSON.parse(row.value);
  } catch {
    return {};
  }
}

function saveApiConfigPatch(patch) {
  const cur = getApiConfig();
  const next = { ...cur };
  if (patch.llm) next.llm = { ...(cur.llm || {}), ...patch.llm };
  if (patch.llm2) next.llm2 = { ...(cur.llm2 || {}), ...patch.llm2 };
  if (patch.image) next.image = { ...(cur.image || {}), ...patch.image };
  if (patch.video) next.video = { ...(cur.video || {}), ...patch.video };
  if (patch.analyze) next.analyze = { ...(cur.analyze || {}), ...patch.analyze };
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'api_config',
    JSON.stringify(next)
  );
  return next;
}

function migrateApiConfigLlm2DefaultOnce() {
  try {
    const cur = getApiConfig();
    if (cur.llm2 != null) return;
    saveApiConfigPatch({
      llm2: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        key: '',
        endpoint: '',
      },
    });
    console.log('[xunyu] 已补充 api_config.llm2（2 号备用大模型，默认 DeepSeek；请在后台填写 Key）');
  } catch (e) {
    console.warn('[xunyu] llm2 migration skipped:', e && e.message);
  }
}

/** 拍我 OpenAPI：model c1 不支持 sound_effect_switch；旧库若曾开启则启动时关闭一次 */
function migrateVideoC1SoundEffectOffOnce() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('video_c1_sound_effect_api_v1');
    if (row && String(row.value || '').trim()) return;
    const cur = getApiConfig();
    const v = cur.video;
    if (!v || typeof v !== 'object') {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'video_c1_sound_effect_api_v1',
        '1'
      );
      return;
    }
    const m = String(v.model || '').trim().toLowerCase();
    if (m !== 'c1') {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'video_c1_sound_effect_api_v1',
        '1'
      );
      return;
    }
    const off = v.soundEffectSwitch === false || v.sound_effect_switch === false;
    if (!off) {
      const next = { ...v, soundEffectSwitch: false };
      delete next.sound_effect_switch;
      saveApiConfigPatch({ video: next });
      console.log('[xunyu] 拍我 model c1 不支持 sound_effect_switch，已关闭「生成视频自带声音」');
    }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'video_c1_sound_effect_api_v1',
      '1'
    );
  } catch (e) {
    console.warn('[xunyu] c1 sound_effect_switch migration skipped:', e && e.message);
  }
}

/** 一次性：曾保存 fast + 不支持 fast 的 model 时，改为 C1 + normal，避免上游报错 */
function migratePaiwoFastMotionIncompatibleOnce() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('pixverse_motion_fast_fix_v1');
    if (row && String(row.value || '').trim()) return;
    const cur = getApiConfig();
    const v = cur.video || {};
    if (String(v.provider || '').trim() !== 'paiwo') {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'pixverse_motion_fast_fix_v1',
        '1'
      );
      return;
    }
    const model = String(v.model || 'c1').trim();
    const motion = String(v.motionMode || v.motion_mode || 'normal').trim().toLowerCase();
    if (motion === 'fast' && !paiwoModelSupportsFastMotion(model)) {
      const next = { ...v, model: 'c1', motionMode: 'normal' };
      delete next.motion_mode;
      saveApiConfigPatch({ video: next });
      console.log(
        '[xunyu] 拍我视频：motion_mode=fast 仅支持 v3.5/v4/v4.5，已将配置改为 model=c1、motionMode=normal'
      );
    }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'pixverse_motion_fast_fix_v1',
      '1'
    );
  } catch (e) {
    console.warn('[xunyu] pixverse motion migration skipped:', e && e.message);
  }
}

function getAdminUser() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_user');
    return row?.value ? JSON.parse(row.value) : { username: 'admin', password_hash: '' };
  } catch {
    return { username: 'admin', password_hash: '' };
  }
}

function setAdminUser(obj) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'admin_user',
    JSON.stringify(obj)
  );
}

function normalizeChatCompletionContent(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && p.type === 'text' && p.text) return String(p.text);
        return '';
      })
      .join('')
      .trim();
  }
  return String(raw).trim();
}

async function callOpenAIChatCompletions(endpoint, key, model, messages, system, timeoutMs, extraBody) {
  const ep = (endpoint || '').trim() || 'https://api.openai.com/v1/chat/completions';
  const k = normalizeBearerApiKey(key);
  const m = (model || '').trim() || 'gpt-4o-mini';
  if (!k) {
    throw new Error('未配置 API Key，请在管理后台保存');
  }
  const body = Object.assign(
    {
      model: m,
      messages: system
        ? [{ role: 'system', content: system }, ...messages]
        : messages,
      temperature: 0.7,
    },
    extraBody && typeof extraBody === 'object' ? extraBody : {}
  );
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 120000);
  let res;
  try {
    res = await fetch(ep, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'XunyuServer/1.0 OpenAI-Compatible-Client',
        Authorization: `Bearer ${k}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const snip = text.trim();
    const isHtml = /^<!doctype|^<html/i.test(snip);
    const finalUrl = (res && res.url) || ep;
    const hint = isHtml
      ? `收到 HTML 而非 JSON（请求 URL: ${finalUrl}）。请核对是否为 Chat Completions 的 JSON 接口地址（百炼示例：https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions）、API Key 与网络是否可达。`
      : `接口返回非 JSON（${finalUrl}）：${snip.slice(0, 120)}${snip.length > 120 ? '…' : ''}`;
    throw new Error(hint);
  }
  if (!res.ok) {
    const rawErr =
      (json && json.error && (json.error.message || json.error)) ||
      (json && typeof json.message === 'string' && json.message) ||
      (json && json.msg) ||
      text.slice(0, 400);
    let msg = typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr);
    const dashHost = /dashscope(-intl|-us)?\.aliyuncs\.com/i.test(ep);
    if (
      dashHost &&
      /apikey not found|HMAC signature cannot be verified/i.test(msg) &&
      !/请逐项核对：/i.test(msg)
    ) {
      msg +=
        '。请逐项核对：① Base 与 Key 同属一地域（北京/新加坡/弗吉尼亚与控制台地域一致）；② 使用百炼「通用」API Key（多为 sk- 开头），勿用 AccessKey；③ 若为 **Coding 专属 Key（sk-sp- 开头）**，不可配在本站兼容地址，需换通用 Key；④ Key 若启用 **IP 白名单**，须包含本服务器出口公网 IP。';
    }
    throw new Error(msg);
  }
  const content = normalizeChatCompletionContent(json.choices?.[0]?.message?.content);
  if (!content) throw new Error('模型无返回内容');
  return content;
}

/**
 * Chat Completions 流式（SSE）。返回拼接后的全文；onDelta 收到每个文本增量（可为空字符串跳过）。
 * 上游若不支持 stream 或非 SSE，将抛错，由调用方回退非流式。
 */
async function callOpenAIChatCompletionsStream(endpoint, key, model, messages, system, timeoutMs, onDelta) {
  const ep = (endpoint || '').trim() || 'https://api.openai.com/v1/chat/completions';
  const k = normalizeBearerApiKey(key);
  const m = (model || '').trim() || 'gpt-4o-mini';
  if (!k) throw new Error('未配置 API Key，请在管理后台保存');
  const body = Object.assign(
    {
      model: m,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      temperature: 0.7,
      stream: true,
    },
    {}
  );
  const ac = new AbortController();
  const tlim = Math.max(60000, Number(timeoutMs) || 300000);
  const timer = setTimeout(() => ac.abort(), tlim);
  try {
    const res = await fetch(ep, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'XunyuServer/1.0 OpenAI-Compatible-Client',
        Authorization: `Bearer ${k}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let msg = errText.slice(0, 500);
      try {
        const j = JSON.parse(errText);
        msg =
          (j.error && (j.error.message || j.error)) ||
          (typeof j.message === 'string' && j.message) ||
          msg;
      } catch (_) {}
      throw new Error(typeof msg === 'string' ? msg : '流式请求失败');
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('运行环境不支持流式响应体');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseCarry = '';
    let accumulated = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseCarry += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = sseCarry.indexOf('\n');
        if (nl === -1) break;
        const rawLine = sseCarry.slice(0, nl);
        sseCarry = sseCarry.slice(nl + 1);
        const line = String(rawLine).trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (!d) continue;
          let piece = '';
          if (d.content != null) {
            piece =
              typeof d.content === 'string'
                ? d.content
                : normalizeChatCompletionContent(d.content);
          }
          if (piece) {
            accumulated += piece;
            if (typeof onDelta === 'function') onDelta(piece);
          }
        } catch (_) {
          /* 忽略单行解析失败 */
        }
      }
    }
    const tail = sseCarry.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const j = JSON.parse(payload);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content != null) {
            const piece =
              typeof d.content === 'string'
                ? d.content
                : normalizeChatCompletionContent(d.content);
            if (piece) {
              accumulated += piece;
              if (typeof onDelta === 'function') onDelta(piece);
            }
          }
        } catch (_) {}
      }
    }
    return accumulated;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatibleStream(messages, system, timeoutMs, onDelta) {
  const slots = getLlmFailoverSlots();
  if (!slots.length) throw new Error('未配置 API Key，请在管理后台保存');
  let lastErr;
  for (let si = 0; si < slots.length; si++) {
    const s = slots[si];
    try {
      const raw = await callOpenAIChatCompletionsStream(
        s.ep,
        s.key,
        s.model,
        messages,
        system,
        timeoutMs,
        (piece) => {
          if (onDelta) onDelta(piece, undefined);
        }
      );
      if (si > 0) console.warn('[llm-stream-failover] ok slot=%s', s.label);
      return raw;
    } catch (e) {
      lastErr = e;
      console.warn('[llm-stream-failover] slot=%s failed: %s', s.label, e && e.message ? e.message : e);
      if (typeof onDelta === 'function') {
        try {
          onDelta(null, { failoverReset: true });
        } catch (_) {}
      }
    }
  }
  throw lastErr;
}

async function callOpenAICompatible(messages, system) {
  return callOpenAIChatCompletionsFailover(messages, system, 120000, undefined);
}

const DASHSCOPE_COMPAT_DEFAULT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
/** 与 initDb 默认一致；自定义 OpenAI 兼容且未填 endpoint 时使用 */
const LLM_OPENAI_COMPAT_DEFAULT =
  'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2/v1/chat/completions';

/**
 * 解析大模型 Chat Completions 完整 URL（与视频反推 resolveAnalyzeChatEndpoint 同理）。
 * 百炼等常只填到 …/compatible-mode/v1，必须补 /chat/completions，否则会打到错误路径或返回非 JSON。
 */
function resolveLlmChatEndpoint(cfg) {
  const provider = String((cfg && cfg.provider) || 'openai-compatible').toLowerCase();
  let ep = String((cfg && cfg.endpoint) || '').trim();
  if (ep) {
    if (/\/chat\/completions(\?|$)/i.test(ep)) return ep.replace(/\/+$/, '');
    const b = ep.replace(/\/+$/, '');
    if (/\/compatible-mode\/v1$/i.test(b)) return `${b}/chat/completions`;
    if (/\/api\/v3$/i.test(b) && /volces|bytepluses|\.ark\./i.test(b)) return `${b}/chat/completions`;
    if (/\/paas\/v4$/i.test(b) && /bigmodel/i.test(b)) return `${b}/chat/completions`;
    if (/\/v1$/i.test(b)) return `${b}/chat/completions`;
    return ep;
  }
  switch (provider) {
    case 'qwen':
      return DASHSCOPE_COMPAT_DEFAULT;
    case 'openai':
      return 'https://api.openai.com/v1/chat/completions';
    case 'zhipu':
      return 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    case 'doubao':
      return 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    case 'deepseek':
      return 'https://api.deepseek.com/v1/chat/completions';
    case 'openai-compatible':
    default:
      return LLM_OPENAI_COMPAT_DEFAULT;
  }
}

function normalizeBearerApiKey(key) {
  let k = String(key || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n|\r|\n/g, '')
    .trim();
  while (/^bearer\s+/i.test(k)) k = k.replace(/^bearer\s+/i, '').trim();
  return k;
}

function defaultLlmModelForProvider(provider) {
  const p = String(provider || 'openai-compatible').toLowerCase();
  if (p === 'qwen') return 'qwen-turbo';
  if (p === 'zhipu') return 'glm-4';
  if (p === 'doubao') return 'doubao-pro';
  if (p === 'deepseek') return 'deepseek-chat';
  return 'gpt-4o-mini';
}

/** 单套大模型：无有效 Key 时返回 null */
function buildLlmSlot(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const key = normalizeBearerApiKey(cfg.key);
  if (!key) return null;
  const ep = resolveLlmChatEndpoint(cfg);
  const model = String(cfg.model || defaultLlmModelForProvider(cfg.provider)).trim();
  return { ep, key, model };
}

/** 主模型 llm + 备用 llm2（如 DeepSeek）；主失败时自动续用备用 */
function getLlmFailoverSlots() {
  const api = getApiConfig();
  const slots = [];
  const a = buildLlmSlot(api.llm || {});
  if (a) slots.push(Object.assign({ label: 'primary' }, a));
  const b = buildLlmSlot(api.llm2 || {});
  if (b) slots.push(Object.assign({ label: 'secondary' }, b));
  return slots;
}

async function callOpenAIChatCompletionsFailover(messages, system, timeoutMs, extraBody) {
  const slots = getLlmFailoverSlots();
  if (!slots.length) throw new Error('未配置 API Key，请在管理后台保存');
  let lastErr;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    try {
      const r = await callOpenAIChatCompletions(s.ep, s.key, s.model, messages, system, timeoutMs, extraBody);
      if (i > 0) console.warn('[llm-failover] ok slot=%s', s.label);
      return r;
    } catch (e) {
      lastErr = e;
      console.warn('[llm-failover] slot=%s failed: %s', s.label, e && e.message ? e.message : e);
    }
  }
  throw lastErr;
}

function resolveAnalyzeChatEndpoint(acfg) {
  let ep = String(acfg.endpoint || '').trim();
  if (ep) {
    if (!/\/chat\/completions(\?|$)/i.test(ep)) {
      const b = ep.replace(/\/+$/, '');
      if (/\/v1$/i.test(b) || /compatible-mode\/v1$/i.test(b)) ep = `${b}/chat/completions`;
    }
    return ep;
  }
  const raw = String(acfg.openaiUrl || acfg.baseUrl || '').trim();
  const base = raw.replace(/\/+$/, '');
  if (base) {
    if (/\/chat\/completions(\?|$)/i.test(base)) return base;
    const b = base.replace(/\/+$/, '');
    if (/\/compatible-mode\/v1$/i.test(b)) return `${b}/chat/completions`;
    if (/\/v1$/i.test(b)) return `${b}/chat/completions`;
    return `${b}/v1/chat/completions`;
  }
  return DASHSCOPE_COMPAT_DEFAULT;
}

function inferPublicOrigin(req) {
  const fixed = (process.env.PUBLIC_SITE_URL || process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  const xfProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = (xfProto || req.protocol || 'http').replace(/:$/, '');
  const host = (req.get('x-forwarded-host') || req.get('host') || '').trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

const MOCK_VIDEO_ANALYSIS = `## 视频镜头分析报告（演示）

### 镜头1 (0-5s) - 开场
- 景别: 全景 · 角度: 平视 · 建立空间

### 镜头2 (5-15s) - 主体
- 景别: 中景 · 角度: 微俯

### 建议
- 当前为**模拟模式**：请在管理后台将「视频反推」切换为**阿里云百炼**并填写 DashScope API Key（OpenAI 兼容模式）。`;

const NANO_BANANA_DEFAULT_BASE = 'https://banana.aigenmedia.art';
const NANO_OPENAI_ASPECT_SHAPE = {
  '16:9': 'landscape',
  '9:16': 'portrait',
  '1:1': 'square',
  '4:3': 'four-three',
  '3:4': 'three-four',
};

function nanoBananaBaseUrl(cfg) {
  const u = (cfg.baseUrl || NANO_BANANA_DEFAULT_BASE).trim().replace(/\/+$/, '');
  return u || NANO_BANANA_DEFAULT_BASE;
}

function resolveNanoOpenAiModel(cfg, body) {
  const fixed = (cfg.model || '').trim();
  if (fixed) return fixed;
  const aspect = String(body.aspect_ratio || cfg.defaultAspect || '1:1').trim();
  const res = String(body.resolution || body.image_size || cfg.defaultResolution || '1K')
    .trim()
    .toUpperCase();
  const shape = NANO_OPENAI_ASPECT_SHAPE[aspect];
  if (!shape) {
    throw new Error(`不支持的比例「${aspect}」，请使用 1:1、3:4、4:3、9:16、16:9`);
  }
  let suffix = '';
  if (res === '1K') suffix = '';
  else if (res === '2K') suffix = '-2k';
  else if (res === '4K') suffix = '-4k';
  else throw new Error(`不支持的分辨率「${res}」，请使用 1K、2K、4K`);
  return `gemini-3.0-pro-image-${shape}${suffix}`;
}

function parseMarkdownImageUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/!\[[^\]]*]\(([^)\s]+)\)/);
  if (m) return m[1].trim();
  const m2 = text.match(/https?:\/\/[^\s"'<>)\]]+/);
  return m2 ? m2[0].trim() : null;
}

function extractImageUrlFromGeminiResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error('Gemini 响应格式异常：无 candidates[0].content.parts');
  }
  for (const part of parts) {
    if (part.inlineData?.data && part.inlineData?.mimeType) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
    if (part.fileData?.fileUri) return String(part.fileData.fileUri).trim();
    if (typeof part.text === 'string') {
      const url = parseMarkdownImageUrl(part.text) || part.text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
      if (url) return url.trim();
    }
  }
  throw new Error('Gemini 响应中未找到图片（inlineData / fileData / URL）');
}

async function nanoBananaFetch(url, key, jsonBody) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), NANO_BANANA_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(jsonBody),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON (${res.status}): ${text.slice(0, 240)}`);
  }
  if (!res.ok) {
    const errMsg =
      json.error?.message ||
      json.error ||
      json.message ||
      (Array.isArray(json.error?.details) && json.error.details.map((d) => d.message).join('; ')) ||
      text.slice(0, 240);
    throw new Error(errMsg || `HTTP ${res.status}`);
  }
  return json;
}

const MAX_REFERENCE_IMAGE_URLS = 5;

function collectReferenceImageUrls(body) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const s = String(u || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(body.reference_urls)) {
    for (const u of body.reference_urls) push(u);
  }
  push(body.reference_url);
  push(body.image_url);
  if (out.length > MAX_REFERENCE_IMAGE_URLS) {
    console.warn(
      '[generate/image] reference_urls truncated from %s to %s',
      out.length,
      MAX_REFERENCE_IMAGE_URLS
    );
  }
  return out.slice(0, MAX_REFERENCE_IMAGE_URLS);
}

async function callNanoBananaOpenAiImage(cfg, body) {
  const key = (cfg.key || '').trim();
  if (!key) throw new Error('未配置 Nano Banana API Key');
  const base = nanoBananaBaseUrl(cfg);
  const model = resolveNanoOpenAiModel(cfg, body);
  const prompt = String(body.prompt || '').trim();
  const refUrls = collectReferenceImageUrls(body);
  const userContent =
    refUrls.length > 0
      ? [
          { type: 'text', text: prompt },
          ...refUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
        ]
      : prompt;
  const url = `${base}/api/v1/chat/completions`;
  const json = await nanoBananaFetch(url, key, {
    model,
    messages: [{ role: 'user', content: userContent }],
  });
  const raw = json.choices?.[0]?.message?.content;
  if (raw == null) throw new Error('OpenAI 兼容接口无返回内容');
  const imageUrl = parseMarkdownImageUrl(String(raw));
  if (!imageUrl) throw new Error('未能从返回内容中解析图片链接（期望 Markdown 图片）');
  return { image_url: imageUrl, model_used: model };
}

async function callNanoBananaGeminiImage(cfg, body) {
  const key = (cfg.key || '').trim();
  if (!key) throw new Error('未配置 Nano Banana API Key');
  const base = nanoBananaBaseUrl(cfg);
  const model =
    String(body.gemini_model || cfg.geminiModel || 'gemini-3-pro-image-preview').trim() ||
    'gemini-3-pro-image-preview';
  const aspectRatio = String(
    body.aspect_ratio || cfg.geminiAspect || cfg.defaultAspect || '1:1'
  ).trim();
  const imageSize = String(
    body.resolution ||
      body.image_size ||
      cfg.geminiImageSize ||
      cfg.defaultResolution ||
      '1K'
  )
    .trim()
    .toUpperCase();
  const prompt = String(body.prompt || '').trim();
  const refUrls = collectReferenceImageUrls(body);
  const parts = [{ text: prompt }];
  for (const u of refUrls) {
    parts.push({ imageUrl: u });
  }
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio, imageSize },
    },
  };
  const pathSeg = encodeURIComponent(model) + ':generateContent';
  const url = `${base}/api/gemini/v1beta/models/${pathSeg}`;
  const json = await nanoBananaFetch(url, key, payload);
  const image_url = extractImageUrlFromGeminiResponse(json);
  return { image_url, model_used: model };
}

function normalizeImageDownloadSource(raw) {
  const s = String(raw || '').trim();
  if (!s) return { err: '空地址' };
  if (s.startsWith('data:image/')) return { kind: 'data', dataUrl: s };
  if (s.startsWith('/') && !s.startsWith('//')) {
    if (!s.startsWith('/uploads/')) return { err: '仅支持站内 /uploads/ 路径' };
    return { kind: 'local', pathname: s };
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return { err: '无效 URL' };
  }
  if (u.protocol !== 'https:') return { err: '外链代下载仅支持 https' };
  return { kind: 'remote', href: u.href, host: u.hostname.toLowerCase() };
}

function allowedImageDownloadHost(hostname, imageCfg) {
  const h = String(hostname || '').toLowerCase();
  const fixed = ['picsum.photos', 'i.picsum.photos', 'fastly.picsum.photos'];
  if (fixed.includes(h)) return true;
  const bases = [NANO_BANANA_DEFAULT_BASE];
  if (imageCfg && imageCfg.baseUrl) bases.push(String(imageCfg.baseUrl).trim());
  for (const raw of bases) {
    if (!raw) continue;
    try {
      const host = new URL(String(raw).trim()).hostname.toLowerCase();
      if (!host) continue;
      if (h === host) return true;
      if (h.endsWith('.' + host)) return true;
    } catch (_) {}
  }
  return false;
}

function recordConsumption(userId, type, cost) {
  db.prepare(
    'INSERT INTO consumption_records (user_id, type, cost) VALUES (?, ?, ?)'
  ).run(userId, type, cost);
}

function addUserBalance(userId, delta) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(delta, userId);
  const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  return u.balance;
}

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');
app.use(express.json({ limit: '32mb' }));
app.use(
  session({
    name: 'xunyu.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      maxAge: SESSION_COOKIE_MAX_MS,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1',
    },
  })
);

const UPLOAD_EXT_ALLOW = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const raw = path.extname(file.originalname || '').toLowerCase();
    const ext = UPLOAD_EXT_ALLOW.has(raw) ? raw : '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 80 * 1024 * 1024 } });

app.use('/uploads', express.static(UPLOAD_DIR));

function persistGeneratedImageUrlIfData(urlIn) {
  const s = String(urlIn || '').trim();
  if (!s.startsWith('data:image/')) return urlIn;
  const comma = s.indexOf(',');
  if (comma === -1) return urlIn;
  const header = s.slice(0, comma);
  const payload = s.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  let buf;
  try {
    buf = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return urlIn;
  }
  if (!buf || buf.length < 32) return urlIn;
  let ext = 'png';
  const mt = header.match(/^data:image\/([a-zA-Z0-9.+-]+)/);
  if (mt) {
    const w = mt[1].toLowerCase();
    if (w === 'jpeg' || w === 'jpg') ext = 'jpg';
    else if (w === 'webp') ext = 'webp';
    else if (w === 'gif') ext = 'gif';
    else if (w === 'png') ext = 'png';
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const dest = path.join(UPLOAD_DIR, fname);
  try {
    fs.writeFileSync(dest, buf);
    return `/uploads/${fname}`;
  } catch (e) {
    console.warn('[generate/image] persist data image failed:', e.message);
    return urlIn;
  }
}

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json(fail('请先登录', 401));
  }
  const u = db.prepare('SELECT id, balance FROM users WHERE id = ?').get(req.session.userId);
  if (!u) {
    req.session.userId = undefined;
    return res.status(401).json(fail('用户不存在或已删除', 401));
  }
  req.userRow = u;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminLoggedIn) {
    return res.status(401).json(fail('需要管理员登录', 401));
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json(ok({ status: 'ok' }));
});

app.get('/api/user/info', (req, res) => {
  if (!req.session.userId) {
    return res.json(ok(null));
  }
  const u = db
    .prepare(
      'SELECT id, name, phone, username, balance, created_at FROM users WHERE id = ?'
    )
    .get(req.session.userId);
  if (!u) {
    req.session.userId = undefined;
    return res.json(ok(null));
  }
  const cache = getUploadCacheSettings();
  const cacheRetentionHours = cache.retentionHours;
  const cacheNotice =
    cacheRetentionHours > 0
      ? `保存在本站「上传目录」的图片、视频及落盘生成的图片，约在 ${cacheRetentionHours} 小时后自动清理，请及时下载。外部平台生成的成片以各平台规则为准。`
      : '当前未开启上传目录自动清理（以管理后台配置为准）。外部平台成片仍建议尽快自行保存。';
  return res.json(ok({ ...u, cacheRetentionHours, cacheNotice }));
});

app.get('/api/user/consumption-records', requireUser, (req, res) => {
  const uid = req.session.userId;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '80'), 10) || 80));
  const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
  const rows = db
    .prepare(
      'SELECT id, type, cost, created_at FROM consumption_records WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    )
    .all(uid, limit, offset);
  return res.json(ok({ records: rows, limit, offset }));
});

app.post('/api/user/change-password', requireUser, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.json(fail('请填写当前密码和新密码'));
  if (String(new_password).length < 6) return res.json(fail('新密码至少6位'));
  const u = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.session.userId);
  if (!u || !bcrypt.compareSync(String(current_password), u.password_hash)) {
    return res.json(fail('当前密码错误'));
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(String(new_password), 10),
    u.id
  );
  return res.json(ok(true));
});

app.post('/api/register', (req, res) => {
  const { name, phone, username, password } = req.body || {};
  if (!name || !phone || !username || !password) {
    return res.json(fail('参数不完整'));
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.json(fail('手机号格式不正确'));
  if (username.length < 3 || username.length > 20) return res.json(fail('用户名长度3-20'));
  if (password.length < 6) return res.json(fail('密码至少6位'));
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.json(fail('用户名已存在'));
  const hash = bcrypt.hashSync(password, 10);
  const initial = 10;
  const info = db
    .prepare(
      'INSERT INTO users (name, phone, username, password_hash, balance) VALUES (?,?,?,?,?)'
    )
    .run(name, phone, username, hash, initial);
  return res.json(ok({ id: info.lastInsertRowid, username, balance: initial }));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json(fail('用户名或密码为空'));
  const u = db
    .prepare('SELECT id, username, password_hash, balance FROM users WHERE username = ?')
    .get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.json(fail('用户名或密码错误'));
  }
  req.session.userId = u.id;
  return res.json(ok({ username: u.username, balance: u.balance }));
});

app.post('/api/logout', (req, res) => {
  req.session.userId = undefined;
  res.json(ok(true));
});

app.get('/api/director/config-hint', requireUser, (_req, res) => {
  const v = getApiConfig().video || {};
  return res.json(
    ok({
      costs: {
        image: COST.image,
        prompt: COST.prompt,
        script: COST.script,
        shotSuggest: COST.shotSuggest,
        text_to_video: COST.text_to_video,
        image_to_video: COST.image_to_video,
      },
      videoProvider: String(v.provider || 'mock'),
      videoModel: String(v.model || '').trim(),
      videoQuality: String(v.quality || '720p').trim(),
    })
  );
});

function mergeDirectorAssetLists(lists) {
  const byId = new Map();
  for (const arr of lists) {
    if (!Array.isArray(arr)) continue;
    for (const a of arr) {
      if (!a || typeof a !== 'object') continue;
      const id = String(a.id || '').trim();
      const key =
        id ||
        `${String(a.name || '').trim()}|${String(a.imageUrl || '').trim()}|${byId.size}`;
      if (!byId.has(key)) byId.set(key, a);
    }
  }
  return [...byId.values()];
}

/** 当前账号全局：演员 / 场景 / 道具（与项目 state 分离存储） */
function getUserAssetsLibrary(uid) {
  const row = db.prepare('SELECT assets_json FROM director_user_assets_library WHERE user_id = ?').get(uid);
  if (!row || row.assets_json == null) {
    return { actors: [], scenes: [], props: [], panoScenes: [] };
  }
  try {
    const o = JSON.parse(row.assets_json);
    return {
      actors: Array.isArray(o.actors) ? o.actors : [],
      scenes: Array.isArray(o.scenes) ? o.scenes : [],
      props: Array.isArray(o.props) ? o.props : [],
      panoScenes: Array.isArray(o.panoScenes) ? o.panoScenes : [],
    };
  } catch {
    return { actors: [], scenes: [], props: [], panoScenes: [] };
  }
}

function saveUserAssetsLibrary(uid, assets) {
  const o = {
    actors: Array.isArray(assets && assets.actors) ? assets.actors : [],
    scenes: Array.isArray(assets && assets.scenes) ? assets.scenes : [],
    props: Array.isArray(assets && assets.props) ? assets.props : [],
    panoScenes: Array.isArray(assets && assets.panoScenes) ? assets.panoScenes : [],
  };
  const s = JSON.stringify(o);
  if (s.length > 1_400_000) throw new Error('角色库数据过大');
  db.prepare(
    `INSERT INTO director_user_assets_library (user_id, assets_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       assets_json = excluded.assets_json,
       updated_at = excluded.updated_at`
  ).run(uid, s);
}

/**
 * 首次写入全局素材库：合并旧表 director_user_actor_library + 各项目 state 中的三类素材（按 id 去重）
 */
function migrateUserAssetsLibraryOnce(uid) {
  const exists = db.prepare('SELECT 1 AS ok FROM director_user_assets_library WHERE user_id = ?').get(uid);
  if (exists) return;

  let legacyActors = [];
  try {
    const leg = db.prepare('SELECT actors_json FROM director_user_actor_library WHERE user_id = ?').get(uid);
    if (leg && leg.actors_json != null) {
      const parsed = JSON.parse(leg.actors_json);
      if (Array.isArray(parsed)) legacyActors = parsed;
    }
  } catch {
    legacyActors = [];
  }

  const actorLists = [legacyActors];
  const sceneLists = [];
  const propLists = [];
  const panoSceneLists = [];
  const rows = db.prepare('SELECT state_json FROM director_projects WHERE user_id = ?').all(uid);
  for (const pr of rows) {
    let st;
    try {
      st = JSON.parse(pr.state_json || '{}');
    } catch {
      continue;
    }
    const as = st.assets;
    if (!as || typeof as !== 'object') continue;
    if (Array.isArray(as.actors)) actorLists.push(as.actors);
    if (Array.isArray(as.scenes)) sceneLists.push(as.scenes);
    if (Array.isArray(as.props)) propLists.push(as.props);
    if (Array.isArray(as.panoScenes)) panoSceneLists.push(as.panoScenes);
  }

  const merged = {
    actors: mergeDirectorAssetLists(actorLists),
    scenes: mergeDirectorAssetLists(sceneLists),
    props: mergeDirectorAssetLists(propLists),
    panoScenes: mergeDirectorAssetLists(panoSceneLists),
  };
  db.prepare(
    'INSERT INTO director_user_assets_library (user_id, assets_json, updated_at) VALUES (?,?,datetime(\'now\'))'
  ).run(uid, JSON.stringify(merged));
}

app.get('/api/director/projects', requireUser, (req, res) => {
  const uid = req.session.userId;
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.updated_at, p.series_id, s.title AS series_title
       FROM director_projects p
       LEFT JOIN director_series s ON s.id = p.series_id AND s.user_id = p.user_id
       WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 80`
    )
    .all(uid);
  return res.json(ok({ projects: rows }));
});

app.get('/api/director/series', requireUser, (req, res) => {
  const uid = req.session.userId;
  const seriesRows = db
    .prepare(
      'SELECT id, title, updated_at FROM director_series WHERE user_id = ? ORDER BY id DESC'
    )
    .all(uid);
  const projRows = db
    .prepare(
      'SELECT id, title, updated_at, series_id FROM director_projects WHERE user_id = ? ORDER BY id ASC'
    )
    .all(uid);
  const bySeries = {};
  const orphans = [];
  for (const p of projRows) {
    const sid = p.series_id;
    if (sid == null) {
      orphans.push({ id: p.id, title: p.title, updated_at: p.updated_at });
    } else {
      if (!bySeries[sid]) bySeries[sid] = [];
      bySeries[sid].push({ id: p.id, title: p.title, updated_at: p.updated_at });
    }
  }
  const series = seriesRows.map((s) => ({
    id: s.id,
    title: s.title,
    updated_at: s.updated_at,
    episodes: bySeries[s.id] || [],
  }));
  return res.json(ok({ series, orphans }));
});

app.post('/api/director/series', requireUser, (req, res) => {
  const uid = req.session.userId;
  const title = String((req.body || {}).title || '未命名短剧').trim().slice(0, 200) || '未命名短剧';
  const r = db.prepare('INSERT INTO director_series (user_id, title) VALUES (?,?)').run(uid, title);
  return res.json(ok({ id: r.lastInsertRowid, title }));
});

app.delete('/api/director/series/:id', requireUser, (req, res) => {
  const uid = req.session.userId;
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.json(fail('无效短剧'));
  const row = db.prepare('SELECT id FROM director_series WHERE id = ? AND user_id = ?').get(id, uid);
  if (!row) return res.json(fail('短剧不存在', 404));
  db.prepare('DELETE FROM director_projects WHERE user_id = ? AND series_id = ?').run(uid, id);
  db.prepare('DELETE FROM director_series WHERE id = ? AND user_id = ?').run(id, uid);
  return res.json(ok({}));
});

app.post('/api/director/project', requireUser, (req, res) => {
  const uid = req.session.userId;
  const body = req.body || {};
  const title = String(body.title || '未命名短剧').trim().slice(0, 200) || '未命名短剧';
  let seriesId = null;
  if (body.seriesId != null && body.seriesId !== '') {
    const sid = parseInt(String(body.seriesId), 10);
    if (Number.isFinite(sid)) {
      const sr = db.prepare('SELECT id FROM director_series WHERE id = ? AND user_id = ?').get(sid, uid);
      if (!sr) return res.json(fail('短剧不存在或无权限'));
      seriesId = sid;
    }
  }
  let epNum = 1;
  if (seriesId != null) {
    const c = db
      .prepare('SELECT COUNT(*) AS n FROM director_projects WHERE user_id = ? AND series_id = ?')
      .get(uid, seriesId);
    epNum = c && Number.isFinite(Number(c.n)) ? Number(c.n) + 1 : 1;
  }
  const defaultState = {
    aspect: '9:16',
    duration: 5,
    settings: {
      imageAspect: '9:16',
      imageResolution: '1K',
      videoAspect: '9:16',
      videoQuality: '720p',
    },
    episodeTitle: seriesId != null ? '第' + epNum + '集' : '未命名剧集 · 第1集',
    cast_notes: '',
    assets: { actors: [], scenes: [], props: [], panoScenes: [] },
    shots: Array.from({ length: 4 }, (_, i) => ({
      id: `s${i + 1}`,
      description: '',
      characters: '',
      cameraMove: '',
      cameraMoveSpace: '',
      cameraMoveEmotion: '',
      cameraMoveNarrative: '',
      cameraMoveLongTrans: '',
      cameraMoveAerial: '',
      refUrls: [],
      imageUrl: '',
      videoUrl: '',
    })),
    chat: [],
  };
  const stateJson = JSON.stringify(defaultState);
  const r = db
    .prepare(
      'INSERT INTO director_projects (user_id, title, state_json, series_id) VALUES (?,?,?,?)'
    )
    .run(uid, title, stateJson, seriesId);
  return res.json(ok({ id: r.lastInsertRowid, title, series_id: seriesId }));
});

app.delete('/api/director/project/:id', requireUser, (req, res) => {
  const uid = req.session.userId;
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.json(fail('无效项目'));
  const del = db.prepare('DELETE FROM director_projects WHERE id = ? AND user_id = ?').run(id, uid);
  if (!del.changes) return res.json(fail('项目不存在', 404));
  return res.json(ok({}));
});

app.get('/api/director/project/:id', requireUser, (req, res) => {
  const uid = req.session.userId;
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.json(fail('无效项目'));
  migrateUserAssetsLibraryOnce(uid);
  const row = db
    .prepare(
      'SELECT p.id, p.title, p.state_json, p.updated_at, p.series_id FROM director_projects p WHERE p.id = ? AND p.user_id = ?'
    )
    .get(id, uid);
  if (!row) return res.json(fail('项目不存在', 404));
  let state;
  try {
    state = JSON.parse(row.state_json || '{}');
  } catch {
    state = {};
  }
  state.assets = getUserAssetsLibrary(uid);
  return res.json(
    ok({
      id: row.id,
      title: row.title,
      state,
      updated_at: row.updated_at,
      series_id: row.series_id == null ? null : row.series_id,
    })
  );
});

app.put('/api/director/project/:id', requireUser, (req, res) => {
  const uid = req.session.userId;
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id)) return res.json(fail('无效项目'));
  const row = db
    .prepare('SELECT title, state_json FROM director_projects WHERE id = ? AND user_id = ?')
    .get(id, uid);
  if (!row) return res.json(fail('项目不存在', 404));
  const body = req.body || {};
  let nextTitle = row.title;
  if (typeof body.title === 'string') {
    const t = body.title.trim().slice(0, 200);
    if (t) nextTitle = t;
  }
  let nextStateStr = row.state_json;
  if (body.state != null) {
    migrateUserAssetsLibraryOnce(uid);
    try {
      const st = JSON.parse(JSON.stringify(body.state));
      if (!st || typeof st !== 'object') return res.json(fail('state 格式无效'));
      if (!st.assets || typeof st.assets !== 'object')
        st.assets = { actors: [], scenes: [], props: [], panoScenes: [] };
      try {
        saveUserAssetsLibrary(uid, st.assets);
      } catch (e) {
        return res.json(fail(e.message || '保存角色库失败'));
      }
      st.assets = { actors: [], scenes: [], props: [], panoScenes: [] };
      nextStateStr = JSON.stringify(st);
      if (nextStateStr.length > 1_500_000) return res.json(fail('分镜数据过大'));
    } catch {
      return res.json(fail('state 格式无效'));
    }
  }
  db.prepare(
    'UPDATE director_projects SET title = ?, state_json = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'
  ).run(nextTitle, nextStateStr, id, uid);
  return res.json(ok({ id }));
});

function stripMarkdownJsonFence(s) {
  let t = String(s || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/im);
  if (m) t = m[1].trim();
  return t;
}

/** 修复模型常见 JSON 语法问题：尾随逗号、零宽字符、弯引号等 */
function stripTrailingCommasInJson(str) {
  let out = String(str || '');
  let prev;
  do {
    prev = out;
    out = out.replace(/,(\s*[\]}])/g, '$1');
  } while (out !== prev);
  return out;
}

function sanitizeLlmJsonCandidate(t) {
  return String(t || '')
    .replace(/\u0000/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/[\u201C\u201D\uFF02]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function parseDirectorBoardJsonObject(t) {
  const s = stripTrailingCommasInJson(sanitizeLlmJsonCandidate(t));
  try {
    return JSON.parse(s);
  } catch (e0) {
    try {
      const { jsonrepair } = require('jsonrepair');
      return JSON.parse(jsonrepair(s));
    } catch (e1) {
      const hint = (e0 && e0.message) || String(e0);
      throw new Error(
        '分镜 JSON 解析失败（' +
          hint +
          '）。请重试；或在②中将对白里的英文双引号改为「」、删除异常控制符后再生成。'
      );
    }
  }
}

function resolveRefNamesFromCatalog(refNames, catalog) {
  const urls = [];
  const seen = new Set();
  const arr = Array.isArray(refNames) ? refNames : [];
  const kinds = ['actors', 'scenes', 'props'];
  if (!catalog || typeof catalog !== 'object') return urls;
  for (let i = 0; i < arr.length && urls.length < 5; i++) {
    const want = String(arr[i] || '').trim();
    if (!want) continue;
    let found = null;
    for (const k of kinds) {
      const list = catalog[k];
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        const nm = String(it.name || '').trim();
        const iu = String(it.imageUrl || '').trim();
        if (!nm || !iu) continue;
        if (nm === want || nm.includes(want) || want.includes(nm)) {
          found = iu;
          break;
        }
      }
      if (found) break;
    }
    if (found && !seen.has(found)) {
      seen.add(found);
      urls.push(found);
    }
  }
  return urls;
}

function formatAssetsCatalogForPrompt(catalog) {
  const lines = [
    '【素材白名单】每条分镜的 ref_names 只能从上列名称中原样抄写；不要编造名称；无合适素材则该镜 ref_names 用 []。',
  ];
  const keys = [
    ['actors', '演员'],
    ['scenes', '场景'],
    ['props', '道具'],
  ];
  for (const [key, cn] of keys) {
    const list = catalog && Array.isArray(catalog[key]) ? catalog[key] : [];
    const names = list
      .map((it) => String((it && it.name) || '').trim())
      .filter(Boolean);
    lines.push(`${cn}：${names.length ? names.join('、') : '（空）'}`);
  }
  return lines.join('\n');
}

function parseDirectorBoardJson(raw, catalog) {
  let t = stripMarkdownJsonFence(raw);
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('模型未返回可解析的 JSON');
  t = t.slice(start, end + 1);
  const obj = parseDirectorBoardJsonObject(t);
  if (!obj || typeof obj !== 'object') throw new Error('JSON 根必须为对象');
  const shotsIn = obj.shots;
  if (!Array.isArray(shotsIn) || !shotsIn.length) {
    throw new Error('JSON 中缺少 shots 数组或为空');
  }
  const castNotes = String(obj.cast_notes || obj.castNotes || '').trim();
  const shots = [];
  for (let i = 0; i < shotsIn.length; i++) {
    const row = shotsIn[i];
    if (!row || typeof row !== 'object') continue;
    const description = String(row.description || row.desc || row.画面 || '').trim();
    if (!description) continue;
    const characters = String(
      row.characters || row.cast || row.出场人物 || row.人物 || ''
    ).trim();
    let refUrls = [];
    if (catalog && typeof catalog === 'object') {
      const rn = row.ref_names != null ? row.ref_names : row.refNames;
      refUrls = resolveRefNamesFromCatalog(rn, catalog);
    }
    shots.push({
      id: `s${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      description,
      characters,
      refUrls,
      imageUrl: '',
      videoUrl: '',
    });
  }
  if (!shots.length) throw new Error('未能得到有效的分镜行（请检查 description 字段）');
  return { cast_notes: castNotes, shots };
}

/** 分镜表 LLM：提高输出上限，减少 JSON 被截断；超长正文分段多次调用后合并 */
const DIRECTOR_BOARD_LLM_MAX_TOKENS = 8192;
const DIRECTOR_BOARD_SHOTS_SINGLE_MAX = 48;
const DIRECTOR_BOARD_SHOTS_MERGED_MAX = 96;
const DIRECTOR_BOARD_CHUNK_LEN = 11000;
const DIRECTOR_BOARD_CHUNK_OVERLAP = 500;
const DIRECTOR_BOARD_CHUNK_IF_LEN = 9000;

function splitTextForDirectorBoardChunks(text, chunkLen, overlap) {
  const t = String(text || '');
  if (t.length <= chunkLen) return [t];
  const out = [];
  let pos = 0;
  while (pos < t.length) {
    const end = Math.min(t.length, pos + chunkLen);
    out.push(t.slice(pos, end));
    if (end >= t.length) break;
    pos = end - overlap;
    if (pos <= 0) pos = end;
  }
  return out;
}

function mergeDirectorBoardShotRows(parts) {
  const out = [];
  const arrs = Array.isArray(parts) ? parts : [];
  for (const arr of arrs) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (!s || typeof s !== 'object') continue;
      const prev = out[out.length - 1];
      if (
        prev &&
        String(prev.description || '') === String(s.description || '') &&
        String(prev.characters || '') === String(s.characters || '')
      ) {
        continue;
      }
      out.push(s);
    }
  }
  return out;
}

async function callDirectorBoardLlmParse(userMsg, system, catalog, timeoutMs) {
  const raw = await callOpenAIChatCompletionsFailover(
    [{ role: 'user', content: userMsg }],
    system,
    timeoutMs,
    { max_tokens: DIRECTOR_BOARD_LLM_MAX_TOKENS }
  );
  return parseDirectorBoardJson(raw, catalog);
}

/** 剧本页「调用大模型生成分镜表」核心逻辑（纯 LLM，不扣费） */
async function executeDirectorBoardFromSourceWork(sourceText, mode, hint, truncated) {
  const modeExplain =
    mode === 'storyboard' || mode === 'refine'
      ? '用户已提供较粗糙的分镜/场次/镜头表，请润色、补齐镜头语言，并明确每镜的人物出场。'
      : '用户上传的是小说/故事正文或大纲，请拆成竖屏短剧分镜序列，并标注每镜出场人物。';

  const chunks =
    sourceText.length > DIRECTOR_BOARD_CHUNK_IF_LEN
      ? splitTextForDirectorBoardChunks(sourceText, DIRECTOR_BOARD_CHUNK_LEN, DIRECTOR_BOARD_CHUNK_OVERLAP)
      : [sourceText];
  const boardChunked = chunks.length > 1;
  console.log(
    '[director/board-from-source] work start chars=%s chunks=%s mode=%s',
    sourceText.length,
    chunks.length,
    mode
  );

  const shotParts = [];
  const castNoteParts = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkText = chunks[ci];
    const minShots = boardChunked ? 4 : 6;
    const maxShots = boardChunked ? 22 : DIRECTOR_BOARD_SHOTS_SINGLE_MAX;
    const coverageRule = boardChunked
      ? `本请求为长文分段中的第 ${ci + 1}/${chunks.length} 段：请**仅为本段正文**拆镜，必须覆盖本段从开头到结尾的主要情节与情绪转折，不得用「之后」「省略」等一笔带过未写到的戏；不要重复前一段末尾已写过的同一镜头；与前后段在故事顺序上自然衔接。`
      : '必须按原文叙述顺序拆解直至【原文】末尾，不得在未覆盖全文主要情节线的情况下过早结束；篇幅越长，分镜条数应相应增加（在条数上限内尽量拆细）。';
    const system =
      '你是资深短剧总编剧兼分镜导演，熟悉竖屏短剧节奏、强钩子、人物弧光。' +
      '你必须只输出一个 JSON 对象（不要输出其它说明文字），格式严格如下：\n' +
      '{\n' +
      '  "cast_notes": "字符串，汇总本批分镜涉及的主要人物、关系与出场方式（画内/画外/声先出现后露脸等）",\n' +
      '  "shots": [\n' +
      '    {\n' +
      '      "description": "单条分镜：景别、机位/运镜、画面内容、节奏与时长感、情绪与关键对白提示（中文）",\n' +
      '      "characters": "本镜头出场人物：姓名+身份；无人物写「无」或说明为环境/道具戏"\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      `要求：shots 至少 ${minShots} 条、最多 ${maxShots} 条；每条 description 不少于 30 字；characters 必须与剧情一致；合法 JSON 使用双引号。` +
      coverageRule +
      '字符串值内禁止未转义的英文半角双引号 " ，对白请用「」或『』。';

    const userMsg =
      (truncated ? '【注意】原文已截断至前 48000 字。\n\n' : '') +
      (boardChunked
        ? `【全文共约 ${sourceText.length} 字，已分 ${chunks.length} 段顺序处理】\n\n`
        : '') +
      modeExplain +
      (hint ? `\n\n【用户补充要求】\n${hint}` : '') +
      '\n\n【原文/素材】\n' +
      chunkText;

    const t0 = Date.now();
    const chunkParsed = await callDirectorBoardLlmParse(userMsg, system, undefined, 180000);
    console.log(
      '[director/board-from-source] chunk %s/%s ok ms=%s shots=%s',
      ci + 1,
      chunks.length,
      Date.now() - t0,
      Array.isArray(chunkParsed.shots) ? chunkParsed.shots.length : 0
    );
    if (chunkParsed.cast_notes) castNoteParts.push(chunkParsed.cast_notes);
    shotParts.push(chunkParsed.shots);
  }

  let shots = boardChunked
    ? mergeDirectorBoardShotRows(shotParts)
    : shotParts[0] || [];
  if (shots.length > DIRECTOR_BOARD_SHOTS_MERGED_MAX) {
    shots = shots.slice(0, DIRECTOR_BOARD_SHOTS_MERGED_MAX);
  } else if (!boardChunked && shots.length > DIRECTOR_BOARD_SHOTS_SINGLE_MAX) {
    shots = shots.slice(0, DIRECTOR_BOARD_SHOTS_SINGLE_MAX);
  }
  const merged = {
    cast_notes: castNoteParts.filter(Boolean).join('\n'),
    shots,
  };
  shots.forEach((s) => {
    if (!Array.isArray(s.refUrls)) s.refUrls = [];
  });
  console.log(
    '[director/board-from-source] work done merged_shots=%s board_chunked=%s',
    shots.length,
    boardChunked
  );
  return {
    cast_notes: merged.cast_notes,
    shots,
    board_chunked: boardChunked,
    board_chunks: boardChunked ? chunks.length : 1,
  };
}

/** 超级编导长任务：POST 立即返回 job_id，GET 轮询，避免 Nginx 等对长 POST 返回 504 */
const directorNovelScreenplayJobs = new Map();
const directorScreenplayBoardJobs = new Map();
const directorBoardFromSourceJobs = new Map();
/** 编导八工种研讨：异步执行，避免反代在长寿 POST 上 504 */
const directorEffectCommercialJobs = new Map();

function pruneDirectorLongJobs() {
  const now = Date.now();
  const maxAge = 45 * 60 * 1000;
  for (const [id, j] of directorNovelScreenplayJobs) {
    if (now - j.createdAt > maxAge) directorNovelScreenplayJobs.delete(id);
  }
  for (const [id, j] of directorScreenplayBoardJobs) {
    if (now - j.createdAt > maxAge) directorScreenplayBoardJobs.delete(id);
  }
  for (const [id, j] of directorBoardFromSourceJobs) {
    if (now - j.createdAt > maxAge) directorBoardFromSourceJobs.delete(id);
  }
  for (const [id, j] of directorEffectCommercialJobs) {
    if (now - j.createdAt > maxAge) directorEffectCommercialJobs.delete(id);
  }
}

async function runDirectorBoardFromSourceJob(jobId) {
  const job = directorBoardFromSourceJobs.get(jobId);
  if (!job || job.status !== 'pending') return;
  const uid = job.userId;
  console.log(
    '[director/board-from-source] job=%s user=%s chars=%s',
    jobId,
    uid,
    String(job.sourceText || '').length
  );
  try {
    const r = await executeDirectorBoardFromSourceWork(job.sourceText, job.mode, job.hint, job.truncated);
    addUserBalance(uid, -COST.script);
    recordConsumption(uid, 'director_board', COST.script);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    job.status = 'done';
    job.result = Object.assign(
      {
        balance,
        cost: COST.script,
        truncated: job.truncatedInput,
      },
      r
    );
    directorBoardFromSourceJobs.set(jobId, job);
    console.log('[director/board-from-source] job=%s done user=%s shots=%s', jobId, uid, r.shots?.length ?? 0);
  } catch (e) {
    job.status = 'failed';
    job.error = e.name === 'AbortError' ? '剧本分镜请求超时' : e.message || '生成失败';
    directorBoardFromSourceJobs.set(jobId, job);
    console.warn('[director/board-from-source] job=%s fail user=%s: %s', jobId, uid, job.error);
  }
}

app.post('/api/director/board-from-source', requireUser, (req, res) => {
  try {
    pruneDirectorLongJobs();
    const body = req.body || {};
    const mode = String(body.mode || 'novel').trim();
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.script) return res.json(fail('积分不足'));
    let sourceText = String(body.sourceText || '').trim();
    if (!sourceText) return res.json(fail('请粘贴小说片段、大纲或现有分镜文本'));
    const maxLen = 48000;
    let truncated = false;
    if (sourceText.length > maxLen) {
      sourceText = sourceText.slice(0, maxLen);
      truncated = true;
    }
    const hint = String(body.hint || '').trim().slice(0, 2000);
    const jobId = 'bfs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    directorBoardFromSourceJobs.set(jobId, {
      userId: uid,
      status: 'pending',
      createdAt: Date.now(),
      sourceText,
      mode,
      hint,
      truncated,
      truncatedInput: truncated,
    });
    setImmediate(() => {
      runDirectorBoardFromSourceJob(jobId).catch((err) => {
        const j = directorBoardFromSourceJobs.get(jobId);
        if (j && j.status === 'pending') {
          j.status = 'failed';
          j.error = err.message || String(err);
          directorBoardFromSourceJobs.set(jobId, j);
        }
      });
    });
    return res.json(ok({ job_id: jobId }));
  } catch (e) {
    return res.json(fail(e.message || '失败'));
  }
});

app.get('/api/director/board-from-source/status', requireUser, (req, res) => {
  pruneDirectorLongJobs();
  const jobId = String(req.query.job_id || '').trim();
  const job = directorBoardFromSourceJobs.get(jobId);
  if (!job || job.userId !== req.session.userId) return res.json(fail('任务不存在', 404));
  if (job.status === 'pending') return res.json(ok({ status: 'pending' }));
  if (job.status === 'failed') return res.json(ok({ status: 'failed', error: job.error || '失败' }));
  return res.json(ok({ status: 'done', data: job.result }));
});

const NOVEL_SCREENPLAY_CHUNK_LEN = 9000;
const NOVEL_SCREENPLAY_CHUNK_OVERLAP = 400;
/** 超过此字数则分段多次调用大模型，缩短单次耗时、降低上游/反代超时概率 */
const NOVEL_SCREENPLAY_CHUNK_IF_LEN = 8000;
const NOVEL_SCREENPLAY_MAX_TOKENS_SINGLE = 8192;
const NOVEL_SCREENPLAY_MAX_TOKENS_CHUNK = 6144;

async function runDirectorNovelScreenplayJob(jobId) {
  const job = directorNovelScreenplayJobs.get(jobId);
  if (!job || job.status !== 'pending') return;
  const uid = job.userId;
  const novelText = job.novelText;
  const truncated = job.truncatedInput;
  try {
    const novelChunks =
      novelText.length > NOVEL_SCREENPLAY_CHUNK_IF_LEN
        ? splitTextForDirectorBoardChunks(novelText, NOVEL_SCREENPLAY_CHUNK_LEN, NOVEL_SCREENPLAY_CHUNK_OVERLAP)
        : [novelText];
    const segmented = novelChunks.length > 1;

    const systemSingle =
      '你是短剧总编剧与现场执行导演。用户会粘贴小说/故事正文或大纲。请改写成「可直接开拍的竖屏短剧剧本」：用 Markdown 输出，' +
      '结构含：一、故事线与节奏总览；二、分场次表（场号+戏名+内景/外景+昼夜）；三、每场戏的画内动作、人物调度、关键对白要点、镜头节奏提示；四、转场与悬念钩子。' +
      '语言精炼可执行，避免空泛形容词堆砌；不要输出 JSON；不要复述用户全文。篇幅建议 3500～9000 字，**全文输出请控制在 11000 汉字以内**；若原文极长可聚焦一条完整戏剧线。';
    const systemSegmented =
      '你是短剧总编剧与现场执行导演。用户小说较长，将按顺序分段提供。每次请**只**根据当前消息里的「本段小说」改写成可直接开拍的竖屏短剧剧本片段：用 Markdown，含场次（场号+戏名+内景/外景+昼夜）、画内动作与调度、关键对白要点、镜头节奏；' +
      '本段成品建议控制在 2800～5500 汉字；不要提前编写尚未提供的后段小说；场次编号与情绪线须与「已写剧本末段」自然衔接；勿逐字重复末段已有正文。不要输出 JSON。';

    let screenplay = '';
    for (let ci = 0; ci < novelChunks.length; ci++) {
      const system = segmented ? systemSegmented : systemSingle;
      let userContent;
      if (!segmented) {
        userContent = novelChunks[0];
      } else {
        const tail =
          screenplay.length > 720
            ? screenplay.slice(-720)
            : screenplay.trim() || '（尚无，本段为开篇）';
        userContent =
          (ci > 0
            ? '【已写剧本末段·供衔接（勿全文照抄，承接场次与人物状态即可）】\n' + tail + '\n\n'
            : '') +
          `【小说原文 第 ${ci + 1}/${novelChunks.length} 段】\n` +
          novelChunks[ci];
      }
      const raw = await callOpenAIChatCompletionsFailover(
        [{ role: 'user', content: userContent }],
        system,
        segmented ? 180000 : 240000,
        {
          max_tokens: segmented ? NOVEL_SCREENPLAY_MAX_TOKENS_CHUNK : NOVEL_SCREENPLAY_MAX_TOKENS_SINGLE,
        }
      );
      const piece = String(raw || '')
        .replace(/\u0000/g, '')
        .trim();
      if (!piece) throw new Error('模型未返回有效剧本（第 ' + (ci + 1) + '/' + novelChunks.length + ' 段）');
      screenplay += screenplay ? '\n\n' + piece : piece;
    }

    screenplay = screenplay.trim();
    if (!screenplay) throw new Error('模型未返回有效剧本');
    const maxOut = 96000;
    let outTrunc = false;
    if (screenplay.length > maxOut) {
      screenplay = screenplay.slice(0, maxOut);
      outTrunc = true;
    }
    addUserBalance(uid, -COST.script);
    recordConsumption(uid, 'director_novel_screenplay', COST.script);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    job.status = 'done';
    job.result = {
      screenplay,
      balance,
      cost: COST.script,
      truncated: truncated || outTrunc,
      novel_segmented: segmented,
      novel_chunks: novelChunks.length,
    };
    directorNovelScreenplayJobs.set(jobId, job);
  } catch (e) {
    job.status = 'failed';
    job.error = e.name === 'AbortError' ? '小说转剧本请求超时' : e.message || '生成失败';
    directorNovelScreenplayJobs.set(jobId, job);
  }
}

async function runDirectorScreenplayBoardJob(jobId) {
  const job = directorScreenplayBoardJobs.get(jobId);
  if (!job || job.status !== 'pending') return;
  const uid = job.userId;
  const screenplay = job.screenplay;
  const catalog = job.catalog;
  console.log(
    '[director/screenplay-to-board] job=%s user=%s chars=%s',
    jobId,
    uid,
    String(screenplay || '').length
  );
  try {
    const whiteList = formatAssetsCatalogForPrompt(catalog);
    const chunks =
      screenplay.length > DIRECTOR_BOARD_CHUNK_IF_LEN
        ? splitTextForDirectorBoardChunks(screenplay, DIRECTOR_BOARD_CHUNK_LEN, DIRECTOR_BOARD_CHUNK_OVERLAP)
        : [screenplay];
    const boardChunked = chunks.length > 1;
    console.log('[director/screenplay-to-board] job=%s chunks=%s', jobId, chunks.length);

    const shotParts = [];
    const castNoteParts = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkText = chunks[ci];
      const minShots = boardChunked ? 4 : 6;
      const maxShots = boardChunked ? 22 : DIRECTOR_BOARD_SHOTS_SINGLE_MAX;
      const coverageRule = boardChunked
        ? `本请求为长剧本分段中的第 ${ci + 1}/${chunks.length} 段：请**仅为本段剧本**拆镜，必须覆盖本段从开头到结尾的戏，不得省略未拆到的情节；不要重复前一段末尾已写过的同一镜头；ref_names 仍须遵守白名单。`
        : '必须按剧本叙述顺序拆解直至【本段定稿剧本】末尾，不得在未覆盖主要情节线的情况下过早结束；篇幅越长，分镜条数应相应增加（在条数上限内尽量拆细）。';
      const system =
        '你是资深短剧分镜导演。你必须只输出一个 JSON 对象（不要输出其它说明文字），格式严格如下：\n' +
        '{\n' +
        '  "cast_notes": "字符串，汇总本批分镜涉及的主要人物、关系与出场方式",\n' +
        '  "shots": [\n' +
        '    {\n' +
        '      "description": "单条分镜：景别、机位/运镜、画面内容、节奏与情绪、关键对白提示（中文）",\n' +
        '      "characters": "本镜头出场人物：姓名+身份；无人物写「无」或说明为环境/道具戏",\n' +
        '      "ref_names": ["仅从【素材白名单】抄写的名称0～5个，按本镜需要选；无则 []"]\n' +
        '    }\n' +
        '  ]\n' +
        '}\n' +
        `要求：shots 至少 ${minShots} 条、最多 ${maxShots} 条；每条 description 不少于 30 字；ref_names 中的字符串必须与白名单某一名称完全一致或为其子串匹配项在服务端会解析为参考图 URL；合法 JSON 使用双引号。` +
        coverageRule +
        '【重要】description、characters 等字符串值内禁止出现未转义的英文半角双引号 " ；对白与引语请用中文直角引号「」或『』表示，否则会导致 JSON 损坏。';

      const userMsg =
        whiteList +
        (boardChunked ? `\n\n【定稿剧本共约 ${screenplay.length} 字，已分 ${chunks.length} 段顺序处理】` : '') +
        '\n\n【定稿剧本·用于拆成分镜】\n' +
        chunkText;

      const t0 = Date.now();
      const chunkParsed = await callDirectorBoardLlmParse(userMsg, system, catalog, 240000);
      console.log(
        '[director/screenplay-to-board] job=%s chunk %s/%s ok ms=%s shots=%s',
        jobId,
        ci + 1,
        chunks.length,
        Date.now() - t0,
        Array.isArray(chunkParsed.shots) ? chunkParsed.shots.length : 0
      );
      if (chunkParsed.cast_notes) castNoteParts.push(chunkParsed.cast_notes);
      shotParts.push(chunkParsed.shots);
    }

    let shots = boardChunked
      ? mergeDirectorBoardShotRows(shotParts)
      : shotParts[0] || [];
    if (shots.length > DIRECTOR_BOARD_SHOTS_MERGED_MAX) {
      shots = shots.slice(0, DIRECTOR_BOARD_SHOTS_MERGED_MAX);
    } else if (!boardChunked && shots.length > DIRECTOR_BOARD_SHOTS_SINGLE_MAX) {
      shots = shots.slice(0, DIRECTOR_BOARD_SHOTS_SINGLE_MAX);
    }
    const merged = {
      cast_notes: castNoteParts.filter(Boolean).join('\n'),
      shots,
    };
    shots.forEach((s) => {
      if (!Array.isArray(s.refUrls)) s.refUrls = [];
    });
    addUserBalance(uid, -COST.script);
    recordConsumption(uid, 'director_screenplay_board', COST.script);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    job.status = 'done';
    job.result = {
      cast_notes: merged.cast_notes,
      shots,
      balance,
      cost: COST.script,
      board_chunked: boardChunked,
      board_chunks: boardChunked ? chunks.length : 1,
    };
    directorScreenplayBoardJobs.set(jobId, job);
    console.log('[director/screenplay-to-board] job=%s done user=%s shots=%s', jobId, uid, shots.length);
  } catch (e) {
    job.status = 'failed';
    job.error = e.name === 'AbortError' ? '剧本转分镜请求超时' : e.message || '生成失败';
    directorScreenplayBoardJobs.set(jobId, job);
    console.warn('[director/screenplay-to-board] job=%s fail user=%s: %s', jobId, uid, job.error);
  }
}

app.post('/api/director/novel-to-screenplay', requireUser, (req, res) => {
  try {
    pruneDirectorLongJobs();
    const body = req.body || {};
    let novelText = String(body.novelText || '').trim();
    if (!novelText) return res.json(fail('请粘贴小说或正文'));
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.script) return res.json(fail('积分不足'));
    const maxLen = 48000;
    let truncated = false;
    if (novelText.length > maxLen) {
      novelText = novelText.slice(0, maxLen);
      truncated = true;
    }
    const jobId = 'nov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    directorNovelScreenplayJobs.set(jobId, {
      userId: uid,
      status: 'pending',
      createdAt: Date.now(),
      novelText,
      truncatedInput: truncated,
    });
    setImmediate(() => {
      runDirectorNovelScreenplayJob(jobId).catch((err) => {
        const j = directorNovelScreenplayJobs.get(jobId);
        if (j && j.status === 'pending') {
          j.status = 'failed';
          j.error = err.message || String(err);
          directorNovelScreenplayJobs.set(jobId, j);
        }
      });
    });
    return res.json(ok({ job_id: jobId }));
  } catch (e) {
    return res.json(fail(e.message || '失败'));
  }
});

app.get('/api/director/novel-to-screenplay/status', requireUser, (req, res) => {
  pruneDirectorLongJobs();
  const jobId = String(req.query.job_id || '').trim();
  const job = directorNovelScreenplayJobs.get(jobId);
  if (!job || job.userId !== req.session.userId) return res.json(fail('任务不存在', 404));
  if (job.status === 'pending') return res.json(ok({ status: 'pending' }));
  if (job.status === 'failed') return res.json(ok({ status: 'failed', error: job.error || '失败' }));
  return res.json(ok({ status: 'done', data: job.result }));
});

app.post('/api/director/screenplay-to-board-smart', requireUser, (req, res) => {
  try {
    pruneDirectorLongJobs();
    const body = req.body || {};
    let screenplay = String(body.screenplay || '').trim();
    if (!screenplay) return res.json(fail('请提供定稿剧本正文'));
    const catalog = body.assetsCatalog && typeof body.assetsCatalog === 'object' ? body.assetsCatalog : {};
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.script) return res.json(fail('积分不足'));
    if (screenplay.length > 32000) screenplay = screenplay.slice(0, 32000);
    const jobId = 'spb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    directorScreenplayBoardJobs.set(jobId, {
      userId: uid,
      status: 'pending',
      createdAt: Date.now(),
      screenplay,
      catalog,
    });
    setImmediate(() => {
      runDirectorScreenplayBoardJob(jobId).catch((err) => {
        const j = directorScreenplayBoardJobs.get(jobId);
        if (j && j.status === 'pending') {
          j.status = 'failed';
          j.error = err.message || String(err);
          directorScreenplayBoardJobs.set(jobId, j);
        }
      });
    });
    return res.json(ok({ job_id: jobId }));
  } catch (e) {
    return res.json(fail(e.message || '失败'));
  }
});

app.get('/api/director/screenplay-to-board-smart/status', requireUser, (req, res) => {
  pruneDirectorLongJobs();
  const jobId = String(req.query.job_id || '').trim();
  const job = directorScreenplayBoardJobs.get(jobId);
  if (!job || job.userId !== req.session.userId) return res.json(fail('任务不存在', 404));
  if (job.status === 'pending') return res.json(ok({ status: 'pending' }));
  if (job.status === 'failed') return res.json(ok({ status: 'failed', error: job.error || '失败' }));
  return res.json(ok({ status: 'done', data: job.result }));
});

app.post('/api/director/shot-suggest', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const kind = String(body.kind || '').trim().toLowerCase();
    const allowed = ['writer', 'director', 'camera'];
    if (allowed.indexOf(kind) === -1) return res.json(fail('无效建议类型'));
    const desc = String(body.description || '').trim();
    if (!desc) return res.json(fail('请先填写本镜描述'));
    if (desc.length > 8000) return res.json(fail('描述过长，请缩短后重试'));
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.shotSuggest) return res.json(fail('积分不足'));
    const characters = String(body.characters || '').trim().slice(0, 2000);
    const castNotes = String(body.cast_notes || '').trim().slice(0, 4000);
    const episodeTitle = String(body.episodeTitle || '').trim().slice(0, 200);

    const systems = {
      writer:
        '你是竖屏短剧的专业编剧顾问。用户会提供一镜的「分镜描述」及可选的出场人物与全剧人物说明。' +
        '请从情节张力、冲突与悬念、对白与潜台词、信息递进、人物动机等角度，给出可直接供编剧参考的修改建议。' +
        '使用简洁的中文，可分条叙述（可用「·」或数字序号），不要全文改写成分镜台本；总字数约 120～350 字。',
      director:
        '你是竖屏短剧的专业导演顾问。根据用户提供的分镜描述与人物信息，从场面调度、情绪节奏、镜头叙事重点、与前后镜可能的衔接等方面给出实操建议。' +
        '使用简洁中文，可分条叙述，不要直接改写成完整剧本；总字数约 120～350 字。',
      camera:
        '你是竖屏短剧的摄影指导（DP）顾问。根据分镜描述，从景别、机位与角度、运镜方式、光影与气氛、构图要点等方面给出摄影执行建议。' +
        '使用简洁中文，可分条叙述，不要堆砌器材型号；总字数约 120～350 字。',
    };
    const roleName = { writer: '编剧', director: '导演', camera: '摄影' }[kind];
    let userContent = '';
    if (episodeTitle) userContent += '【剧集标题】' + episodeTitle + '\n\n';
    if (castNotes) userContent += '【全剧人物 / 出场总览】\n' + castNotes + '\n\n';
    if (characters) userContent += '【本镜出场人物】' + characters + '\n\n';
    userContent += '【当前分镜描述（' + roleName + '视角待优化）】\n' + desc;

    const raw = await callOpenAICompatible([{ role: 'user', content: userContent }], systems[kind]);
    let text = String(raw == null ? '' : raw).trim();
    if (text.length > 4000) text = text.slice(0, 4000);
    addUserBalance(uid, -COST.shotSuggest);
    recordConsumption(uid, 'director_shot_suggest', COST.shotSuggest);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    return res.json(ok({ text, balance, kind }));
  } catch (e) {
    const m = e.name === 'AbortError' ? '请求超时，请缩短描述后重试' : e.message || '生成失败';
    return res.json(fail(m));
  }
});

function parseShotBreakdownFromLlm(raw) {
  let t = stripMarkdownJsonFence(String(raw == null ? '' : raw).trim());
  const i0 = t.indexOf('{');
  const i1 = t.lastIndexOf('}');
  if (i0 === -1 || i1 <= i0) throw new Error('no json object');
  t = stripTrailingCommasInJson(sanitizeLlmJsonCandidate(t.slice(i0, i1 + 1)));
  let o;
  try {
    o = JSON.parse(t);
  } catch (e0) {
    try {
      const { jsonrepair } = require('jsonrepair');
      o = JSON.parse(jsonrepair(t));
    } catch (e1) {
      throw new Error('no json object');
    }
  }
  if (!o || typeof o !== 'object') throw new Error('invalid');
  const str = (v) => String(v == null ? '' : v).trim().slice(0, 2000);
  return {
    actors: str(o.actors != null ? o.actors : o.出镜演员 != null ? o.出镜演员 : o.演员),
    scene: str(o.scene != null ? o.scene : o.场景),
    props: str(o.props != null ? o.props : o.道具),
    weather: str(o.weather != null ? o.weather : o.天气),
    time: str(o.time != null ? o.time : o.时间 != null ? o.时间 : o.时段),
  };
}

app.post('/api/director/shot-breakdown', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const desc = String(body.description || '').trim();
    if (!desc) return res.json(fail('请先填写本镜描述'));
    if (desc.length > 8000) return res.json(fail('描述过长，请缩短后重试'));
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.shotSuggest) return res.json(fail('积分不足'));
    const characters = String(body.characters || '').trim().slice(0, 2000);
    const castNotes = String(body.cast_notes || '').trim().slice(0, 4000);
    const episodeTitle = String(body.episodeTitle || '').trim().slice(0, 200);
    const system =
      '你是影视制片统筹与场记。只根据用户给出的竖屏短剧分镜信息，提炼本镜的要素。' +
      '**严禁臆测**：分镜描述（及可选的「本镜出场人物」）里**没有写明**的演员、场景地点、道具、群众等，一律**不要**编造、不要按「短剧惯例」补典型配角或常见道具；没有依据时对应字段只写 **「未明示」** 整段即可，不要罗列多个虚构名称。' +
      '你必须只输出**一段合法 JSON**，不要 Markdown、不要代码围栏、不要任何 JSON 以外的文字。' +
      'JSON 必须含且仅含这 5 个字符串键（键名固定为英文），值用**简短中文**（每条尽量 80 字以内；无法从描述判断时该键的值写 **「未明示」**）：\n' +
      '{"actors":"","scene":"","props":"","weather":"","time":""}\n' +
      'actors：仅分镜与出场信息**明确写出**的出镜者/称呼/身份；无则填「未明示」。\n' +
      'scene：仅**明确写出**的地点或空间（室内/外等）；无则「未明示」。\n' +
      'props：仅**明确写出**且对画面或叙事重要的物件；无则「未明示」。\n' +
      'weather：仅文本**明确写出**的天气等；无则「未明示」。\n' +
      'time：仅文本**明确写出**的时段/昼夜/季节/时间点；无则「未明示」。';
    let userContent = '';
    if (episodeTitle) userContent += '【剧集标题】' + episodeTitle + '\n\n';
    if (castNotes) userContent += '【全剧人物 / 出场总览】\n' + castNotes + '\n\n';
    if (characters) userContent += '【本镜出场人物（若有）】' + characters + '\n\n';
    userContent += '【当前分镜描述】\n' + desc;
    const raw = await callOpenAICompatible([{ role: 'user', content: userContent }], system);
    let breakdown;
    try {
      breakdown = parseShotBreakdownFromLlm(raw);
    } catch (_) {
      return res.json(fail('模型返回格式异常，请重试'));
    }
    addUserBalance(uid, -COST.shotSuggest);
    recordConsumption(uid, 'director_shot_breakdown', COST.shotSuggest);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    return res.json(ok({ breakdown, balance }));
  } catch (e) {
    const m = e.name === 'AbortError' ? '请求超时，请缩短描述后重试' : e.message || '生成失败';
    return res.json(fail(m));
  }
});

function parseShotOptimizeSuggestionFromLlm(raw) {
  let t = stripMarkdownJsonFence(String(raw == null ? '' : raw).trim());
  const i0 = t.indexOf('{');
  const i1 = t.lastIndexOf('}');
  if (i0 === -1 || i1 <= i0) throw new Error('no json object');
  t = stripTrailingCommasInJson(sanitizeLlmJsonCandidate(t.slice(i0, i1 + 1)));
  let o;
  try {
    o = JSON.parse(t);
  } catch (e0) {
    try {
      const { jsonrepair } = require('jsonrepair');
      o = JSON.parse(jsonrepair(t));
    } catch (e1) {
      throw new Error('no json object');
    }
  }
  if (!o || typeof o !== 'object') throw new Error('invalid');
  const str = (v) => String(v == null ? '' : v).trim();
  let suggestion = str(o.suggestion != null ? o.suggestion : o.text);
  if (suggestion.length > 6000) suggestion = suggestion.slice(0, 6000);
  if (!suggestion) throw new Error('empty suggestion');
  return { suggestion };
}

/** 根据已生成的编剧/导演/摄影建议输出「分镜优化建议」文案；前端仅弹窗展示，不改写用户分镜描述（扣钻与单条建议相同） */
app.post('/api/director/shot-optimize-description', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const desc = String(body.description || '').trim();
    if (!desc) return res.json(fail('请先填写本镜描述'));
    if (desc.length > 8000) return res.json(fail('描述过长，请缩短后重试'));
    const sw = String(body.suggestWriter || '').trim().slice(0, 4000);
    const sd = String(body.suggestDirector || '').trim().slice(0, 4000);
    const sc = String(body.suggestCamera || '').trim().slice(0, 4000);
    if (!sw && !sd && !sc) {
      return res.json(fail('请先使用「编剧建议」「导演建议」「摄影建议」至少生成一项内容'));
    }
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.shotSuggest) return res.json(fail('积分不足'));
    const characters = String(body.characters || '').trim().slice(0, 2000);
    const castNotes = String(body.cast_notes || '').trim().slice(0, 4000);
    const episodeTitle = String(body.episodeTitle || '').trim().slice(0, 200);

    const system =
      '你是竖屏短剧分镜顾问。用户会提供「当前分镜描述」以及编剧、导演、摄影三则书面建议（可能仅部分有内容）。\n' +
      '【任务】综合三则建议与当前分镜描述，输出一段**分镜优化建议**（中文），供用户阅读后**自行决定是否**改分镜正文；**禁止**输出「改写后的完整分镜描述」整段替换稿，**禁止**输出 JSON 键 description 或要求用户一键替换正文。\n' +
      '建议内容可含：画面与节奏可加强点、与三则建议的对齐方式、景别/机位/情绪上的提醒、与前后镜衔接的注意点等；分条叙述，总字数约 280～900 字。\n' +
      '【输出格式】**只输出一段合法 JSON**，不要 Markdown、不要代码围栏、不要 JSON 以外的任何字符。键名固定为：{"suggestion":""}';

    let userContent = '';
    if (episodeTitle) userContent += '【剧集标题】' + episodeTitle + '\n\n';
    if (castNotes) userContent += '【全剧人物 / 出场总览】\n' + castNotes + '\n\n';
    if (characters) userContent += '【本镜出场人物】' + characters + '\n\n';
    userContent += '【当前分镜描述】\n' + desc + '\n\n';
    if (sw) userContent += '【编剧建议】\n' + sw + '\n\n';
    if (sd) userContent += '【导演建议】\n' + sd + '\n\n';
    if (sc) userContent += '【摄影建议】\n' + sc + '\n\n';
    userContent += '请只输出 JSON：{"suggestion":"…"}。';

    const raw = await callOpenAICompatible([{ role: 'user', content: userContent }], system);
    let parsed;
    try {
      parsed = parseShotOptimizeSuggestionFromLlm(raw);
    } catch (_) {
      return res.json(fail('模型返回格式异常，请重试'));
    }

    addUserBalance(uid, -COST.shotSuggest);
    recordConsumption(uid, 'director_shot_optimize_desc', COST.shotSuggest);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    return res.json(
      ok({
        suggestion: parsed.suggestion,
        balance,
      })
    );
  } catch (e) {
    const m = e.name === 'AbortError' ? '请求超时，请缩短后重试' : e.message || '生成失败';
    return res.json(fail(m));
  }
});

function parseEffectCommercialWorkshopOutput(raw) {
  let full = String(raw == null ? '' : raw).trim();
  full = full.replace(/^```[a-zA-Z]*\n?/m, '').replace(/\n?```$/m, '').trim();
  const discStart = '<<<XUNYU_AGENT_DISCUSSION>>>';
  const discEnd = '<<<XUNYU_COMMERCIAL_SHOTS>>>';
  const i0 = full.indexOf(discStart);
  const i1 = full.indexOf(discEnd);
  let discussion = '';
  let script = '';
  if (i0 !== -1 && i1 !== -1 && i1 > i0) {
    discussion = full.slice(i0 + discStart.length, i1).trim();
    script = full.slice(i1 + discEnd.length).trim();
  } else {
    const shotMarker = '<<<XUNYU_SHOT>>>';
    const si = full.indexOf(shotMarker);
    if (si !== -1) {
      script = full.slice(si).trim();
      discussion = full.slice(0, si).trim();
      if (!discussion) {
        discussion =
          '（模型未使用标准分隔符；已自「<<<XUNYU_SHOT>>>」起截取为分镜正文；若上文为空请直接查看右侧输出。）';
      }
    } else {
      discussion = full;
    }
  }
  script = String(script || '')
    .replace(/^```[a-zA-Z]*\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();
  return { discussion, script };
}

const EFC_STREAM_DISC = '<<<XUNYU_AGENT_DISCUSSION>>>';
const EFC_STREAM_SHOTS = '<<<XUNYU_COMMERCIAL_SHOTS>>>';

/** 从流式累积正文中切出「研讨区 / 分镜区」供轮询展示 */
function extractWorkshopStreamPanels(buf) {
  const t = String(buf || '');
  const bytes = t.length;
  const i0 = t.indexOf(EFC_STREAM_DISC);
  if (i0 === -1) {
    return { phase: 'warmup', discussion_live: '', script_live: '', stream_bytes: bytes };
  }
  const from = i0 + EFC_STREAM_DISC.length;
  const i1 = t.indexOf(EFC_STREAM_SHOTS, from);
  if (i1 === -1) {
    return {
      phase: 'discussion',
      discussion_live: t.slice(from),
      script_live: '',
      stream_bytes: bytes,
    };
  }
  return {
    phase: 'script',
    discussion_live: t.slice(from, i1),
    script_live: t.slice(i1 + EFC_STREAM_SHOTS.length),
    stream_bytes: bytes,
  };
}

function effectCommercialWorkshopSystemPrompt() {
  return (
    '你是「讯语 · 超级编导」内置的**八工种联合研讨**引擎。在同一篇回复中依次模拟一支竖屏短剧核心主创与把关团队，成员固定为这八类（勿增删角色名）：**编剧**、**导演**、**制片**、**出品**、**摄影**、**美术**、**场记**、**审核**。\n' +
    '用户会提供待商业化改编的素材（广告梗概、粗分场、小说片段、碎片台词或仅有「想要的效果」描述等）。\n\n' +
    '【任务一：联合研讨修订】\n' +
    '八人围绕素材**交叉讨论、提出修改并相互回应**（可质疑、补充、收敛共识），至少两轮；合计**不少于 16 条**发言，且**每一工种至少发言 1 次**。\n' +
    '每条发言**单独一行**，行首必须是以下八种前缀之一（全角方括号「【】」），后接中文冒号「：」，冒号后写内容；**禁止**使用第九种角色名或无前缀段落：\n' +
    '【编剧】：（情节张力、人物动机、对白与信息递进）\n' +
    '【导演】：（场面调度、节奏钩子、叙事重点与镜流）\n' +
    '【制片】：（拍摄可行性、周期体量、场次与资源协调）\n' +
    '【出品】：（受众定位、商业卖点、品牌/平台调性）\n' +
    '【摄影】：（景别机位、运镜、光影气质、竖屏执行）\n' +
    '【美术】：（场景造型、服化道、视觉统一与符号）\n' +
    '【场记】：（连戏、场次承接、时空与道具逻辑）\n' +
    '【审核】：（价值观与合规、敏感表述、可播性与修改建议）\n' +
    '摄影工种**必须**写「【摄影】：」，勿写「【摄影师】」等变体，以保持恰好八类前缀。\n' +
    '发言须具体可执行，避免空泛形容词；研讨全文不超过 4500 字。\n\n' +
    '【任务二：商用分镜剧本】\n' +
    '研讨结束后输出**可直接**在站内「解析并导入分镜表」的正文：仅用 <<<XUNYU_SHOT>>> 分隔块（分隔行须与用户约定**完全一致**、独占一行），镜号从 1 递增；每块含 镜号:、画面:（中文不少于 35 字，含景别+机位/运镜+画面+情绪节奏）、人物:（无人物写 无）；键名可用 画面/描述/镜头。对白用直角引号「」。字符串内禁止未转义的英文半角双引号 "。\n\n' +
    '【输出结构（严格遵守）】\n' +
    '全文必须先出现以下两行分隔符（原样、独占一行），顺序固定：\n' +
    '<<<XUNYU_AGENT_DISCUSSION>>>\n' +
    '（仅写研讨发言，勿写分镜块）\n' +
    '<<<XUNYU_COMMERCIAL_SHOTS>>>\n' +
    '（从下一行起直到结束，**只写** <<<XUNYU_SHOT>>> 分镜块序列；禁止任何前言、后记、Markdown 代码围栏或解释文字）'
  );
}

async function runDirectorEffectCommercialJob(jobId) {
  const job = directorEffectCommercialJobs.get(jobId);
  if (!job || job.status !== 'pending') return;
  const uid = job.userId;
  const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid);
  if (!row || row.balance < COST.script) {
    job.status = 'failed';
    job.error = '积分不足';
    directorEffectCommercialJobs.set(jobId, job);
    return;
  }
  const effectText = String(job.effectText || '').trim();
  const episodeTitle = String(job.episodeTitle || '').trim().slice(0, 200);
  let userMsg = '';
  if (episodeTitle) userMsg += '【当前项目 / 剧集标题】' + episodeTitle + '\n\n';
  userMsg += '【待改编素材】\n' + effectText;
  job.streamBuffer = '';
  let lastPub = 0;
  let raw = '';
  try {
    raw = await callOpenAICompatibleStream(
      [{ role: 'user', content: userMsg }],
      effectCommercialWorkshopSystemPrompt(),
      300000,
      (piece, meta) => {
        if (meta && meta.failoverReset) {
          job.streamBuffer = '';
          lastPub = 0;
          directorEffectCommercialJobs.set(jobId, job);
          return;
        }
        if (piece == null || piece === '') return;
        job.streamBuffer = (job.streamBuffer || '') + piece;
        const now = Date.now();
        if (now - lastPub > 220) {
          lastPub = now;
          directorEffectCommercialJobs.set(jobId, job);
        }
      }
    );
    job.streamBuffer = raw;
    directorEffectCommercialJobs.set(jobId, job);
  } catch (streamErr) {
    console.warn(
      '[director/effect-commercial-workshop] stream fail user=%s, fallback non-stream: %s',
      uid,
      streamErr.message || streamErr
    );
    try {
      raw = await callOpenAICompatible(
        [{ role: 'user', content: userMsg }],
        effectCommercialWorkshopSystemPrompt()
      );
      job.streamBuffer = raw;
      directorEffectCommercialJobs.set(jobId, job);
    } catch (e) {
      job.status = 'failed';
      job.error = e.name === 'AbortError' ? '请求超时，请缩短素材后重试' : e.message || '生成失败';
      directorEffectCommercialJobs.set(jobId, job);
      console.warn('[director/effect-commercial-workshop] job=%s fail user=%s: %s', jobId, uid, job.error);
      return;
    }
  }
  try {
    const parsed = parseEffectCommercialWorkshopOutput(raw);
    addUserBalance(uid, -COST.script);
    recordConsumption(uid, 'director_effect_commercial', COST.script);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    job.status = 'done';
    job.streamBuffer = undefined;
    job.result = {
      discussion: parsed.discussion,
      script: parsed.script,
      balance,
      cost: COST.script,
    };
    directorEffectCommercialJobs.set(jobId, job);
    console.log('[director/effect-commercial-workshop] job=%s done user=%s', jobId, uid);
  } catch (e) {
    job.status = 'failed';
    job.error = e.name === 'AbortError' ? '请求超时，请缩短素材后重试' : e.message || '生成失败';
    directorEffectCommercialJobs.set(jobId, job);
    console.warn('[director/effect-commercial-workshop] job=%s fail user=%s: %s', jobId, uid, job.error);
  }
}

app.post('/api/director/effect-commercial-workshop', requireUser, (req, res) => {
  try {
    pruneDirectorLongJobs();
    const body = req.body || {};
    let effectText = String(body.effectText != null ? body.effectText : body.source || '').trim();
    if (!effectText) return res.json(fail('请粘贴待改编素材'));
    const maxLen = 24000;
    if (effectText.length > maxLen) effectText = effectText.slice(0, maxLen);
    const episodeTitle = String(body.episodeTitle || '').trim().slice(0, 200);
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.script) return res.json(fail('积分不足'));
    const jobId = 'efc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    directorEffectCommercialJobs.set(jobId, {
      userId: uid,
      status: 'pending',
      createdAt: Date.now(),
      effectText,
      episodeTitle,
      streamBuffer: '',
    });
    setImmediate(() => {
      runDirectorEffectCommercialJob(jobId).catch((err) => {
        const j = directorEffectCommercialJobs.get(jobId);
        if (j && j.status === 'pending') {
          j.status = 'failed';
          j.error = err.message || String(err);
          directorEffectCommercialJobs.set(jobId, j);
        }
      });
    });
    return res.json(ok({ job_id: jobId }));
  } catch (e) {
    return res.json(fail(e.message || '失败'));
  }
});

app.get('/api/director/effect-commercial-workshop/status', requireUser, (req, res) => {
  pruneDirectorLongJobs();
  const jobId = String(req.query.job_id || '').trim();
  const job = directorEffectCommercialJobs.get(jobId);
  if (!job || job.userId !== req.session.userId) return res.json(fail('任务不存在', 404));
  if (job.status === 'pending') {
    const buf = job.streamBuffer != null ? String(job.streamBuffer) : '';
    const live = extractWorkshopStreamPanels(buf);
    const cap = (s, n) => {
      const t = String(s || '');
      return t.length <= n ? t : t.slice(-n);
    };
    return res.json(
      ok({
        status: 'pending',
        phase: live.phase,
        discussion_live: cap(live.discussion_live, 28000),
        script_live: cap(live.script_live, 36000),
        stream_bytes: live.stream_bytes,
      })
    );
  }
  if (job.status === 'failed') return res.json(ok({ status: 'failed', error: job.error || '失败' }));
  return res.json(ok({ status: 'done', data: job.result }));
});

app.post('/api/llm/script', requireUser, async (req, res) => {
  try {
    const { topic, video_type, duration, style } = req.body || {};
    const t = (topic || '').trim() || '未命名主题';
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.script) return res.json(fail('积分不足'));
    const system =
      '你是专业短视频脚本策划，输出结构清晰的中文脚本，含分镜、旁白、时长建议。';
    const userMsg = `主题：${t}\n类型：${video_type || '宣传片'}\n目标时长约${duration || 60}秒\n风格：${style || '专业'}`;
    const script = await callOpenAICompatible([{ role: 'user', content: userMsg }], system);
    addUserBalance(uid, -COST.script);
    recordConsumption(uid, 'script_generation', COST.script);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    return res.json(ok({ script, balance }));
  } catch (e) {
    const msg = e.name === 'AbortError' ? '大模型请求超时' : e.message || '生成失败';
    return res.json(fail(msg));
  }
});

app.post('/api/llm/prompt', requireUser, async (req, res) => {
  try {
    const { description, target } = req.body || {};
    const d = (description || '').trim() || '通用创作';
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.prompt) return res.json(fail('积分不足'));
    const system = '你是 AI 视频/图像提示词专家，输出 3-5 条可直接使用的中文提示词，编号列表。';
    const userMsg = `需求：${d}\n目标：${target || 'video'}`;
    const prompts = await callOpenAICompatible([{ role: 'user', content: userMsg }], system);
    addUserBalance(uid, -COST.prompt);
    recordConsumption(uid, 'prompt_generation', COST.prompt);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    return res.json(ok({ prompts, balance }));
  } catch (e) {
    const msg = e.name === 'AbortError' ? '大模型请求超时' : e.message || '生成失败';
    return res.json(fail(msg));
  }
});

/** 无限画布等长寿请求：先 POST 拿 job_id 再轮询，避免反代在 POST 上等 60s 就 504 而 Node 仍成功 */
const imageGenJobs = new Map();

function pruneImageGenJobs() {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000;
  for (const [id, job] of imageGenJobs) {
    if (now - job.createdAt > maxAge) imageGenJobs.delete(id);
  }
}

async function performImageProviderCall(uid, body, p) {
  const cfg = getApiConfig().image || {};
  let image_url;
  let model_used;
  const provider = cfg.provider || 'mock';
  const refCount = collectReferenceImageUrls(body).length;
  console.log(
    '[generate/image] user=%s provider=%s prompt_len=%s ref_images=%s',
    uid,
    provider,
    p.length,
    refCount
  );

  if (provider === 'nano_banana_openai') {
    const r = await callNanoBananaOpenAiImage(cfg, { ...body, prompt: p });
    image_url = r.image_url;
    model_used = r.model_used;
  } else if (provider === 'nano_banana_gemini') {
    const r = await callNanoBananaGeminiImage(cfg, { ...body, prompt: p });
    image_url = r.image_url;
    model_used = r.model_used;
  } else if (provider === 'mock' || !cfg.key) {
    image_url = `https://picsum.photos/seed/${encodeURIComponent(p.slice(0, 40))}/768/432`;
  } else {
    throw new Error(
      '当前图片 Provider 未对接：请选择「模拟模式」或 Nano Banana（OpenAI 兼容 / Gemini 原生），或联系管理员'
    );
  }

  if (typeof image_url === 'string' && image_url.startsWith('data:image/')) {
    image_url = persistGeneratedImageUrlIfData(image_url);
  }
  if (image_url != null && typeof image_url !== 'string') {
    image_url = String(image_url).trim();
  }

  return { image_url, model_used, provider };
}

async function runImageGenJob(jobId) {
  const job = imageGenJobs.get(jobId);
  if (!job || job.status !== 'pending') return;
  const uid = job.userId;
  const body = job.body;
  const p = String(body.prompt || '').trim();
  if (!p) {
    job.status = 'failed';
    job.errorMsg = '提示词不能为空';
    return;
  }
  try {
    const u = db.prepare('SELECT id, balance FROM users WHERE id = ?').get(uid);
    if (!u || u.balance < COST.image) {
      job.status = 'failed';
      job.errorMsg = '积分不足';
      return;
    }
    const { image_url, model_used, provider } = await performImageProviderCall(uid, body, p);

    addUserBalance(uid, -COST.image);
    recordConsumption(uid, 'image_generation', COST.image);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    const payload = { image_url, prompt: p, balance };
    if (model_used) payload.model = model_used;
    job.status = 'done';
    job.result = payload;
    console.log('[generate/image/job] user=%s id=%s ok model=%s', uid, jobId, model_used || provider);
  } catch (e) {
    job.status = 'failed';
    job.errorMsg =
      e.name === 'AbortError'
        ? '图片生成请求超时（大图+多分镜耗时长；若浏览器报 HTTP 504，请在 Nginx 等反代上增大 proxy_read_timeout）'
        : e.message || '生成失败';
    console.warn('[generate/image/job] user=%s id=%s fail: %s', uid, jobId, job.errorMsg);
  }
}

app.get('/api/generate/image/status', requireUser, (req, res) => {
  pruneImageGenJobs();
  const jobId = String(req.query.job_id || '').trim();
  if (!jobId) return res.json(fail('缺少 job_id'));
  const job = imageGenJobs.get(jobId);
  if (!job || job.userId !== req.session.userId) {
    return res.json(fail('任务不存在或已过期', 404));
  }
  if (job.status === 'pending') return res.json(ok({ status: 'pending' }));
  if (job.status === 'failed') {
    return res.json(ok({ status: 'failed', msg: job.errorMsg || '生成失败' }));
  }
  return res.json(ok({ status: 'done', ...job.result }));
});

app.post('/api/generate/image', requireUser, async (req, res) => {
  const uid = req.session.userId;
  try {
    const body = req.body || {};
    const p = String(body.prompt || '').trim();
    if (!p) {
      console.warn('[generate/image] user=%s empty prompt', uid);
      return res.json(fail('提示词不能为空'));
    }
    const u = req.userRow;
    if (u.balance < COST.image) {
      console.warn('[generate/image] user=%s insufficient balance need=%s', uid, COST.image);
      return res.json(fail('积分不足'));
    }

    const wantAsync = body.async === true || body.async === 'true';
    if (wantAsync) {
      pruneImageGenJobs();
      const jobBody = { ...body };
      delete jobBody.async;
      const jobId = crypto.randomBytes(12).toString('hex');
      imageGenJobs.set(jobId, {
        userId: uid,
        status: 'pending',
        body: jobBody,
        createdAt: Date.now(),
      });
      res.json(ok({ job_id: jobId, status: 'pending' }));
      void runImageGenJob(jobId);
      return;
    }

    const { image_url, model_used, provider } = await performImageProviderCall(uid, body, p);

    addUserBalance(uid, -COST.image);
    recordConsumption(uid, 'image_generation', COST.image);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    const payload = { image_url, prompt: p, balance };
    if (model_used) payload.model = model_used;
    console.log('[generate/image] user=%s ok model=%s', uid, model_used || provider);
    return res.json(ok(payload));
  } catch (e) {
    const msg =
      e.name === 'AbortError'
        ? '图片生成请求超时（大图+多分镜耗时长；若浏览器报 HTTP 504，请在 Nginx 等反代上增大 proxy_read_timeout）'
        : e.message || '生成失败';
    console.warn('[generate/image] user=%s fail: %s', uid, msg);
    return res.json(fail(msg));
  }
});

function mockTaskId() {
  return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** 拍我/模拟成视频：POST 立即返回 job_id + 轮询状态，避免反代在长寿 POST 上 504 */
const videoGenJobs = new Map();

function pruneVideoGenJobs() {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000;
  for (const [id, job] of videoGenJobs) {
    if (now - job.createdAt > maxAge) videoGenJobs.delete(id);
  }
}

async function runVideoGenJob(jobId) {
  const job = videoGenJobs.get(jobId);
  if (!job || job.status !== 'pending') return;
  const uid = job.userId;
  const kind = job.kind;
  const payload = job.payload || {};
  const p = String(payload.prompt || '').trim();
  if (!p) {
    job.status = 'failed';
    job.errorMsg = '描述不能为空';
    return;
  }
  const firstImgLog =
    kind === 'image' ? String(payload.firstImageUrl || '').trim().slice(0, 160) : '';
  const aspectLog =
    kind === 'text' || kind === 'image'
      ? String(payload.aspect_ratio || '').trim() || '(cfg默认)'
      : 'n/a';
  console.log(
    '[generate/video/job] start user=%s job=%s kind=%s promptLen=%d firstImage=%s aspect=%s',
    uid,
    jobId,
    kind,
    p.length,
    firstImgLog || '(none)',
    aspectLog
  );
  try {
    const u = db.prepare('SELECT id, balance FROM users WHERE id = ?').get(uid);
    const cfg = getApiConfig().video || {};
    const provider = String(cfg.provider || 'mock').trim();

    if (kind === 'text') {
      if (!u || u.balance < COST.text_to_video) {
        job.status = 'failed';
        job.errorMsg = '积分不足';
        return;
      }
      if (provider === 'paiwo') {
        const sub = await paiwoTextToVideoSubmit(cfg, p, payload.duration, payload.aspect_ratio);
        const videoUrl = await paiwoPollVideoUntilDone(sub.base, sub.apiKey, sub.videoId, 360000, 2500);
        addUserBalance(uid, -COST.text_to_video);
        recordConsumption(uid, 'text_to_video', COST.text_to_video);
        const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
        job.status = 'done';
        job.result = {
          task_id: String(sub.videoId),
          video_url: videoUrl,
          prompt: p,
          duration: paiwoNormalizeDuration(cfg.model, payload.duration),
          cost: COST.text_to_video,
          balance,
        };
        console.log('[generate/video/job] user=%s id=%s kind=text ok', uid, jobId);
        return;
      }
      if (provider !== 'mock' && provider) {
        job.status = 'failed';
        job.errorMsg = '不支持的视频 Provider';
        return;
      }
      addUserBalance(uid, -COST.text_to_video);
      recordConsumption(uid, 'text_to_video', COST.text_to_video);
      const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
      job.status = 'done';
      job.result = {
        task_id: mockTaskId(),
        prompt: p,
        duration: payload.duration || 5,
        cost: COST.text_to_video,
        balance,
      };
      return;
    }

    if (kind === 'image') {
      if (!u || u.balance < COST.image_to_video) {
        job.status = 'failed';
        job.errorMsg = '积分不足';
        return;
      }
      const firstUrl = String(payload.firstImageUrl || '').trim();
      if (provider === 'paiwo') {
        if (!firstUrl) {
          job.status = 'failed';
          job.errorMsg = '缺少参考图地址';
          return;
        }
        const apiKey = String(cfg.key || '').trim();
        if (!apiKey) {
          job.status = 'failed';
          job.errorMsg = '请在管理后台填写拍我AI API Key';
          return;
        }
        const tierQ = String(payload.tierQ || cfg.img2vidFinalQuality || cfg.finalQuality || '1080p').trim();
        const base = paiwoVideoBaseUrl(cfg);
        const imgId = await paiwoUploadImageUrl(base, apiKey, firstUrl);
        console.log(
          '[generate/video/job] paiwo_ref_upload user=%s job=%s img_id=%s ref=%s',
          uid,
          jobId,
          imgId,
          firstUrl.slice(0, 200)
        );
        const sub = await paiwoImageToVideoSubmit(cfg, p, imgId, payload.duration, tierQ, payload.aspect_ratio);
        const pollMs = 360000;
        const videoUrl = await paiwoPollVideoUntilDone(sub.base, sub.apiKey, sub.videoId, pollMs, 2500);
        addUserBalance(uid, -COST.image_to_video);
        recordConsumption(uid, 'image_to_video', COST.image_to_video);
        const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
        job.status = 'done';
        job.result = {
          task_id: String(sub.videoId),
          video_url: videoUrl,
          balance,
          duration: paiwoNormalizeDuration(cfg.model, payload.duration),
          quality_used: tierQ,
          needs_hd_confirm: false,
        };
        console.log(
          '[generate/video/job] user=%s id=%s kind=image ok video_id=%s ref=%s',
          uid,
          jobId,
          sub.videoId,
          firstUrl.slice(0, 200)
        );
        return;
      }
      if (provider !== 'mock' && provider) {
        job.status = 'failed';
        job.errorMsg = '不支持的视频 Provider';
        return;
      }
      addUserBalance(uid, -COST.image_to_video);
      recordConsumption(uid, 'image_to_video', COST.image_to_video);
      const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
      job.status = 'done';
      job.result = { task_id: mockTaskId(), balance, duration: payload.duration || 5 };
      console.log('[generate/video/job] user=%s id=%s kind=image mock_ok', uid, jobId);
    }
  } catch (e) {
    job.status = 'failed';
    job.errorMsg = e.message || '生成失败';
    console.warn('[generate/video/job] user=%s id=%s fail: %s', uid, jobId, job.errorMsg);
  }
}

app.get('/api/generate/video/status', requireUser, (req, res) => {
  pruneVideoGenJobs();
  const jobId = String(req.query.job_id || '').trim();
  if (!jobId) return res.json(fail('缺少 job_id'));
  const job = videoGenJobs.get(jobId);
  if (!job || job.userId !== req.session.userId) {
    return res.json(fail('任务不存在或已过期', 404));
  }
  if (job.status === 'pending') return res.json(ok({ status: 'pending' }));
  if (job.status === 'failed') {
    return res.json(ok({ status: 'failed', msg: job.errorMsg || '生成失败' }));
  }
  return res.json(ok({ status: 'done', ...(job.result || {}) }));
});

const PAIWO_DEFAULT_BASE = 'https://app-api.pixverseai.cn';

function paiwoVideoBaseUrl(cfg) {
  const u = String((cfg && cfg.baseUrl) || PAIWO_DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, '');
  return u || PAIWO_DEFAULT_BASE;
}

function pixverseParseResponseJson(text, urlHint) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`拍我AI返回非 JSON（${urlHint}）：${text.slice(0, 200)}`);
  }
  const code = json.ErrCode ?? json.err_code;
  const errMsg = json.ErrMsg || json.err_msg || '';
  if (code !== undefined && code !== 0) {
    throw new Error(errMsg || `拍我AI错误码 ${code}`);
  }
  return json.Resp != null ? json.Resp : json.resp != null ? json.resp : json;
}

function resolvePublicUploadsUrl(req, raw) {
  const s = String(raw || '').trim();
  if (!s) return { err: '地址为空' };
  if (s.startsWith('http://') || s.startsWith('https://')) return { url: s };
  let pathOnly = s.startsWith('/') ? s : `/${s}`;
  if (!pathOnly.startsWith('/uploads/') || pathOnly.includes('..')) {
    return { err: '仅支持本站路径 /uploads/ 下的资源' };
  }
  const origin = inferPublicOrigin(req);
  if (!origin) {
    return {
      err: '无法推断站点公网地址，请在 .env 设置 PUBLIC_SITE_URL 或通过域名 HTTPS 访问，以便拍我AI拉取图片',
    };
  }
  return { url: origin + pathOnly };
}

function paiwoApplyOptionalVideoFields(cfg, body) {
  if (!cfg || !body || typeof body !== 'object') return;
  const neg = String(cfg.negativePrompt || cfg.negative_prompt || '').trim();
  if (neg) body.negative_prompt = neg;
  const sd = cfg.seed != null ? Number(cfg.seed) : NaN;
  if (Number.isFinite(sd)) body.seed = Math.floor(sd);
  if (cfg.waterMark != null || cfg.water_mark != null) {
    body.water_mark = !!(cfg.waterMark ?? cfg.water_mark);
  }
}

/** 拍我 OpenAPI：sound_effect_switch 在 v6.* 与 c1 上不支持；其余模型按配置附带 */
function paiwoModelSupportsSoundEffect(model) {
  const m = String(model || '').trim().toLowerCase();
  if (m === 'v6' || m.startsWith('v6.')) return false;
  if (m === 'c1') return false;
  return true;
}

/** 拍我 / PixVerse 音效：sound_effect_switch(boolean)、sound_effect_content(string，可选；不传则官方按画面随机生成) */
function paiwoApplySoundEffectFields(cfg, body) {
  if (!cfg || !body || typeof body !== 'object') return;
  const model = String((cfg && cfg.model) || 'c1').trim();
  if (!paiwoModelSupportsSoundEffect(model)) return;
  const on = cfg.soundEffectSwitch === true || cfg.sound_effect_switch === true;
  if (!on) return;
  const txt = String(cfg.soundEffectContent || cfg.sound_effect_content || '').trim();
  body.sound_effect_switch = true;
  if (txt) body.sound_effect_content = txt;
}

/** 拍我 OpenAPI：motion_mode=fast 仅支持 v3.5、v4、v4.5；C1 / v5 / v6 等须用 normal */
function paiwoModelSupportsFastMotion(model) {
  const m = String(model || '').trim().toLowerCase();
  return m === 'v3.5' || m === 'v4' || m === 'v4.5';
}

function paiwoEffectiveMotionMode(model, configuredMotion) {
  const want = String(configuredMotion || 'normal').trim().toLowerCase();
  if (want !== 'fast') return want || 'normal';
  return paiwoModelSupportsFastMotion(model) ? 'fast' : 'normal';
}

function paiwoNormalizeDuration(model, durationIn) {
  const m = String(model || 'c1').toLowerCase();
  let d = Number(durationIn);
  if (!Number.isFinite(d) || d < 1) d = 5;
  if (m.startsWith('v6') || m === 'c1') {
    return Math.min(15, Math.max(1, Math.round(d)));
  }
  if ([5, 8, 10].includes(Math.round(d))) return Math.round(d);
  if (d <= 5) return 5;
  if (d <= 8) return 8;
  return 10;
}

async function paiwoPollVideoUntilDone(base, apiKey, videoId, timeoutMs, intervalMs) {
  const b = base.replace(/\/+$/, '');
  const deadline = Date.now() + (timeoutMs || 120000);
  const iv = intervalMs || 2500;
  while (Date.now() < deadline) {
    const url = `${b}/openapi/v2/video/result/${encodeURIComponent(String(videoId))}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'API-KEY': apiKey,
        'Ai-trace-id': crypto.randomUUID(),
      },
    });
    const text = await res.text();
    const resp = pixverseParseResponseJson(text, url);
    const st = resp.status;
    if (st === 1) {
      const u = resp.url;
      if (!u || typeof u !== 'string') throw new Error('拍我AI: 已完成但未返回视频地址');
      return u.trim();
    }
    if (st === 7) throw new Error('拍我AI: 内容审核未通过');
    if (st === 8) throw new Error('拍我AI: 生成失败');
    if (st != null && st !== 5) throw new Error(`拍我AI: 状态异常 ${st}`);
    await new Promise((r) => setTimeout(r, iv));
  }
  throw new Error('拍我AI: 等待结果超时，请稍后在拍我控制台查看任务');
}

async function paiwoUploadImageUrl(base, apiKey, httpsImageUrl) {
  const b = base.replace(/\/+$/, '');
  const url = `${b}/openapi/v2/image/upload`;
  const fd = new FormData();
  fd.append('image_url', httpsImageUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'API-KEY': apiKey,
      'Ai-trace-id': crypto.randomUUID(),
    },
    body: fd,
  });
  const text = await res.text();
  const resp = pixverseParseResponseJson(text, url);
  const imgId = resp.img_id;
  if (imgId == null) throw new Error('拍我AI: 上传参考图未返回 img_id');
  return Number(imgId);
}

function normalizePaiwoClientAspectRatio(raw) {
  const s = String(raw || '').trim();
  if (['9:16', '16:9', '1:1', '4:3', '3:4'].indexOf(s) !== -1) return s;
  return '';
}

async function paiwoTextToVideoSubmit(cfg, prompt, duration, aspectClient) {
  const base = paiwoVideoBaseUrl(cfg);
  const apiKey = String((cfg && cfg.key) || '').trim();
  if (!apiKey) throw new Error('未配置拍我AI API Key');
  const model = String((cfg && cfg.model) || 'c1').trim();
  const quality = String((cfg && cfg.quality) || '720p').trim();
  const cfgAspectRaw = String((cfg && (cfg.aspectRatio || cfg.aspect_ratio)) || '16:9').trim();
  const cfgAspect = normalizePaiwoClientAspectRatio(cfgAspectRaw) || '16:9';
  const aspect = normalizePaiwoClientAspectRatio(aspectClient) || cfgAspect;
  const motionRaw = String((cfg && (cfg.motionMode || cfg.motion_mode)) || 'normal').trim();
  const motion = paiwoEffectiveMotionMode(model, motionRaw);
  const dur = paiwoNormalizeDuration(model, duration);
  const url = `${base}/openapi/v2/video/text/generate`;
  const body = {
    prompt,
    duration: dur,
    model,
    quality,
    aspect_ratio: aspect,
    motion_mode: motion,
  };
  paiwoApplyOptionalVideoFields(cfg, body);
  paiwoApplySoundEffectFields(cfg, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'API-KEY': apiKey,
      'Ai-trace-id': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const resp = pixverseParseResponseJson(text, url);
  const vid = resp.video_id;
  if (vid == null) throw new Error('拍我AI: 未返回 video_id');
  return { videoId: Number(vid), base, apiKey };
}

async function paiwoImageToVideoSubmit(cfg, prompt, imgId, duration, quality, aspectClient) {
  const base = paiwoVideoBaseUrl(cfg);
  const apiKey = String((cfg && cfg.key) || '').trim();
  if (!apiKey) throw new Error('未配置拍我AI API Key');
  const model = String((cfg && cfg.model) || 'c1').trim();
  const qc = String(quality || (cfg && cfg.quality) || '720p').trim();
  const motionRaw = String((cfg && (cfg.motionMode || cfg.motion_mode)) || 'normal').trim();
  const motion = paiwoEffectiveMotionMode(model, motionRaw);
  const dur = paiwoNormalizeDuration(model, duration);
  const cfgAspectRaw = String((cfg && (cfg.aspectRatio || cfg.aspect_ratio)) || '16:9').trim();
  const cfgAspect = normalizePaiwoClientAspectRatio(cfgAspectRaw) || '16:9';
  const aspect = normalizePaiwoClientAspectRatio(aspectClient) || cfgAspect;
  const url = `${base}/openapi/v2/video/img/generate`;
  const body = {
    prompt,
    img_id: Number(imgId),
    duration: dur,
    model,
    quality: qc,
    motion_mode: motion,
    aspect_ratio: aspect,
  };
  paiwoApplyOptionalVideoFields(cfg, body);
  paiwoApplySoundEffectFields(cfg, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'API-KEY': apiKey,
      'Ai-trace-id': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const resp = pixverseParseResponseJson(text, url);
  const vid = resp.video_id;
  if (vid == null) throw new Error('拍我AI: 未返回 video_id');
  return { videoId: Number(vid), base, apiKey };
}

app.post('/api/generate/video/text', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const { prompt, duration, aspect_ratio } = body;
    const p = (prompt || '').trim();
    if (!p) return res.json(fail('描述不能为空'));
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.text_to_video) return res.json(fail('积分不足'));
    const cfg = getApiConfig().video || {};
    const provider = String(cfg.provider || 'mock').trim();
    const aspectClient = normalizePaiwoClientAspectRatio(aspect_ratio);

    if (body.async) {
      pruneVideoGenJobs();
      const jobId = crypto.randomBytes(12).toString('hex');
      videoGenJobs.set(jobId, {
        userId: uid,
        status: 'pending',
        kind: 'text',
        payload: { prompt: p, duration, aspect_ratio: aspectClient || undefined },
        createdAt: Date.now(),
      });
      void runVideoGenJob(jobId);
      return res.json(ok({ job_id: jobId, status: 'pending' }));
    }

    if (provider === 'paiwo') {
      const sub = await paiwoTextToVideoSubmit(cfg, p, duration, aspectClient);
      const videoUrl = await paiwoPollVideoUntilDone(sub.base, sub.apiKey, sub.videoId, 180000, 2500);
      addUserBalance(uid, -COST.text_to_video);
      recordConsumption(uid, 'text_to_video', COST.text_to_video);
      const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
      return res.json(
        ok({
          task_id: String(sub.videoId),
          video_url: videoUrl,
          prompt: p,
          duration: paiwoNormalizeDuration(cfg.model, duration),
          cost: COST.text_to_video,
          balance,
        })
      );
    }

    if (provider !== 'mock' && provider) {
      return res.json(fail('不支持的视频 Provider，请选择「拍我AI」或「模拟模式」'));
    }
    addUserBalance(uid, -COST.text_to_video);
    recordConsumption(uid, 'text_to_video', COST.text_to_video);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    const task_id = mockTaskId();
    return res.json(
      ok({
        task_id,
        prompt: p,
        duration: duration || 5,
        cost: COST.text_to_video,
        balance,
      })
    );
  } catch (e) {
    return res.json(fail(e.message || '文生视频失败'));
  }
});

app.post('/api/generate/video/image', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const { prompt, image_url, image_urls, duration, aspect_ratio } = body;
    const p = (prompt || '').trim();
    if (!p) return res.json(fail('描述不能为空'));
    const urls = Array.isArray(image_urls) && image_urls.length ? image_urls : image_url ? [image_url] : [];
    if (!urls.length) return res.json(fail('缺少图片地址'));
    const uid = req.session.userId;
    const u = req.userRow;
    if (u.balance < COST.image_to_video) return res.json(fail('积分不足'));
    const cfg = getApiConfig().video || {};
    const provider = String(cfg.provider || 'mock').trim();
    const aspectClient = normalizePaiwoClientAspectRatio(aspect_ratio);

    if (body.async) {
      pruneVideoGenJobs();
      const jobId = crypto.randomBytes(12).toString('hex');
      if (provider === 'paiwo') {
        const finalQ = String(cfg.img2vidFinalQuality || cfg.finalQuality || '1080p').trim();
        let tierQ = finalQ;
        const explicitQ = String(body.quality || '').trim();
        if (explicitQ) tierQ = explicitQ;
        const norm = resolvePublicUploadsUrl(req, urls[0]);
        if (norm.err) return res.json(fail(norm.err));
        const apiKey = String(cfg.key || '').trim();
        if (!apiKey) return res.json(fail('请在管理后台填写拍我AI API Key'));
        videoGenJobs.set(jobId, {
          userId: uid,
          status: 'pending',
          kind: 'image',
          payload: {
            prompt: p,
            duration,
            firstImageUrl: norm.url,
            tierQ,
            aspect_ratio: aspectClient || undefined,
          },
          createdAt: Date.now(),
        });
        void runVideoGenJob(jobId);
        return res.json(ok({ job_id: jobId, status: 'pending' }));
      }
      if (provider !== 'mock' && provider) {
        return res.json(fail('不支持的视频 Provider，请选择「拍我AI」或「模拟模式」'));
      }
      videoGenJobs.set(jobId, {
        userId: uid,
        status: 'pending',
        kind: 'image',
        payload: { prompt: p, duration },
        createdAt: Date.now(),
      });
      void runVideoGenJob(jobId);
      return res.json(ok({ job_id: jobId, status: 'pending' }));
    }

    if (provider === 'paiwo') {
      const finalQ = String(cfg.img2vidFinalQuality || cfg.finalQuality || '1080p').trim();
      let tierQ = finalQ;
      const explicitQ = String(body.quality || '').trim();
      if (explicitQ) tierQ = explicitQ;
      const norm = resolvePublicUploadsUrl(req, urls[0]);
      if (norm.err) return res.json(fail(norm.err));
      const apiKey = String(cfg.key || '').trim();
      if (!apiKey) return res.json(fail('请在管理后台填写拍我AI API Key'));
      const base = paiwoVideoBaseUrl(cfg);
      const imgId = await paiwoUploadImageUrl(base, apiKey, norm.url);
      const sub = await paiwoImageToVideoSubmit(cfg, p, imgId, duration, tierQ, aspectClient);
      const pollMs = 240000;
      const videoUrl = await paiwoPollVideoUntilDone(sub.base, sub.apiKey, sub.videoId, pollMs, 2500);
      addUserBalance(uid, -COST.image_to_video);
      recordConsumption(uid, 'image_to_video', COST.image_to_video);
      const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
      return res.json(
        ok({
          task_id: String(sub.videoId),
          video_url: videoUrl,
          balance,
          duration: paiwoNormalizeDuration(cfg.model, duration),
          quality_used: tierQ,
          needs_hd_confirm: false,
        })
      );
    }

    if (provider !== 'mock' && provider) {
      return res.json(fail('不支持的视频 Provider，请选择「拍我AI」或「模拟模式」'));
    }
    addUserBalance(uid, -COST.image_to_video);
    recordConsumption(uid, 'image_to_video', COST.image_to_video);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    const task_id = mockTaskId();
    return res.json(ok({ task_id, balance, duration: duration || 5 }));
  } catch (e) {
    return res.json(fail(e.message || '图生视频失败'));
  }
});

app.post('/api/upload/image', requireUser, upload.array('files', 10), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.json(fail('未选择文件'));
  const urls = files.map((f) => `/uploads/${f.filename}`);
  return res.json(ok({ urls }));
});

app.post('/api/upload/video', requireUser, upload.single('file'), (req, res) => {
  if (!req.file) return res.json(fail('未选择文件'));
  const url = `/uploads/${req.file.filename}`;
  return res.json(ok({ url }));
});

app.post('/api/video/analyze', requireUser, async (req, res) => {
  const uid = req.session.userId;
  try {
    const raw = String((req.body || {}).video_url || '').trim();
    if (!raw) return res.json(fail('缺少 video_url'));

    let pathOnly = raw;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const u = new URL(raw);
        pathOnly = u.pathname || '';
      } catch {
        return res.json(fail('video_url 无效'));
      }
    }
    if (!pathOnly.startsWith('/uploads/') || pathOnly.includes('..')) {
      return res.json(fail('仅支持本站上传路径 /uploads/ 下的视频'));
    }

    const origin = inferPublicOrigin(req);
    if (!origin) {
      return res.json(fail('无法推断站点公网地址，请通过域名访问（勿仅用 IP 且无 Host）以便模型拉取视频'));
    }
    const videoAbs = origin + pathOnly;

    const u = req.userRow;
    if (u.balance < COST.video_analysis) {
      return res.json(fail('积分不足'));
    }

    const acfg = getApiConfig().analyze || {};
    const provider = String(acfg.provider || 'mock').trim();

    if (provider === 'mock') {
      return res.json(
        ok({
          analysis: MOCK_VIDEO_ANALYSIS,
          balance: u.balance,
          mock: true,
        })
      );
    }

    const system =
      '你是资深影视编导与剪辑指导。请根据用户提供的视频，输出中文「镜头反推」报告：按时间线列出镜头（时间段、景别、角度、运镜/节奏、画面信息）、转场方式与可改进点；条理清晰，使用 Markdown。若无法获取视频画面，请明确说明限制并给出可执行的拆解模板。';

    const key = normalizeBearerApiKey(acfg.key);
    if (!key) return res.json(fail('请在管理后台「视频反推」中填写阿里云百炼 API Key'));
    if (/^sk-sp-/i.test(key)) {
      return res.json(
        fail(
          '当前 API Key 为 Coding 套餐专属（sk-sp- 开头），不能用于百炼 OpenAI 兼容模式（compatible-mode）。请在百炼控制台对应地域下创建「通用」API Key（通常为 sk- 开头、非 sk-sp-），参见：https://help.aliyun.com/zh/model-studio/get-api-key'
        )
      );
    }

    const endpoint = resolveAnalyzeChatEndpoint(acfg);
    const model = (acfg.model || acfg.modelId || 'qwen3-vl-plus').trim();

    let analysis;
    const textOnlyUser = {
      role: 'user',
      content:
        '以下为已上传至本站的视频公网地址（若你无法拉取视频流，请说明限制，并仍按「镜头反推」给出 Markdown 报告框架、典型景别/节奏要点与可执行检查清单）：\n' +
        videoAbs,
    };
    const multiUser = {
      role: 'user',
      content: [
        { type: 'text', text: '请观看以下视频并完成镜头反推分析。' },
        { type: 'video_url', video_url: { url: videoAbs } },
      ],
    };
    try {
      analysis = await callOpenAIChatCompletions(
        endpoint,
        key,
        model,
        [multiUser],
        system,
        180000
      );
    } catch (e1) {
      try {
        analysis = await callOpenAIChatCompletions(
          endpoint,
          key,
          model,
          [textOnlyUser],
          system,
          120000
        );
      } catch (e2) {
        const m2 = (e2 && e2.message) || String(e2);
        const m1 = String(e1 && e1.message ? e1.message : e1);
        let msg = m2;
        if (m1 && m1 !== m2) {
          const dup = m2.includes('收到 HTML') && m1.includes('收到 HTML');
          if (!dup) msg = m2 + '（此前含 video_url 请求：' + m1.slice(0, 140) + (m1.length > 140 ? '…' : '') + '）';
        }
        return res.json(fail(msg));
      }
    }

    addUserBalance(uid, -COST.video_analysis);
    recordConsumption(uid, 'video_analysis', COST.video_analysis);
    const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    return res.json(ok({ analysis, balance }));
  } catch (e) {
    const msg = e.name === 'AbortError' ? '视频反推请求超时' : e.message || '视频反推失败';
    return res.json(fail(msg));
  }
});

app.post('/api/image/attachment', requireUser, async (req, res) => {
  const uid = req.session.userId;
  const norm = normalizeImageDownloadSource(req.body?.url);
  if (norm.err) return res.json(fail(norm.err));
  const imageCfg = getApiConfig().image || {};
  try {
    if (norm.kind === 'data') {
      const comma = norm.dataUrl.indexOf(',');
      if (comma === -1) return res.json(fail('data URL 格式无效'));
      const prefix = norm.dataUrl.slice(0, comma);
      const b64 = norm.dataUrl.slice(comma + 1);
      const dm = prefix.match(/^data:(image\/(?:png|jpeg|webp|gif));base64$/i);
      if (!dm) return res.json(fail('仅支持 png / jpeg / webp / gif 的 base64 data URL'));
      const mime = dm[1].toLowerCase();
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 25 * 1024 * 1024) return res.json(fail('图片过大'));
      const ext =
        mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="xunyu-gen.${ext}"`);
      return res.send(buf);
    }
    if (norm.kind === 'local') {
      const name = path.basename(norm.pathname);
      if (!name || name.includes('..')) return res.json(fail('文件名非法'));
      const fp = path.resolve(UPLOAD_DIR, name);
      if (!fp.startsWith(path.resolve(UPLOAD_DIR))) return res.json(fail('路径非法'));
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return res.json(fail('文件不存在'));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent('xunyu-' + name)}"`
      );
      return res.sendFile(fp);
    }
    if (norm.kind === 'remote') {
      if (!allowedImageDownloadHost(norm.host, imageCfg)) {
        console.warn('[image/attachment] user=%s denied host=%s', uid, norm.host);
        return res.json(fail('该图片域名不允许代下载（请使用「新窗口打开」或联系管理员放行域名）'));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90000);
      let r;
      try {
        r = await fetch(norm.href, { signal: ac.signal, redirect: 'follow' });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) return res.json(fail(`拉取图片失败 HTTP ${r.status}`));
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 30 * 1024 * 1024) return res.json(fail('图片过大'));
      const ct = (r.headers.get('content-type') || 'image/png').split(';')[0].trim();
      const ext =
        ct.includes('jpeg') || ct.includes('jpg')
          ? 'jpg'
          : ct.includes('webp')
            ? 'webp'
            : ct.includes('gif')
              ? 'gif'
              : 'png';
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="xunyu-gen.${ext}"`);
      console.log('[image/attachment] user=%s remote ok bytes=%s host=%s', uid, buf.length, norm.host);
      return res.send(buf);
    }
  } catch (e) {
    console.warn('[image/attachment] user=%s err %s', uid, e.message);
    return res.json(fail(e.name === 'AbortError' ? '下载超时' : e.message || '下载失败'));
  }
  return res.json(fail('不支持'));
});

app.get('/api/admin/check', (req, res) => {
  res.json(ok({ logged_in: !!req.session.adminLoggedIn }));
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const adm = getAdminUser();
  if (!username || !password) return res.json(fail('参数错误'));
  if (username !== adm.username || !bcrypt.compareSync(password, adm.password_hash)) {
    return res.json(fail('账号或密码错误'));
  }
  req.session.adminLoggedIn = true;
  req.session.adminUsername = username;
  return res.json(ok(true));
});

app.post('/api/admin/logout', (req, res) => {
  req.session.adminLoggedIn = false;
  req.session.adminUsername = undefined;
  res.json(ok(true));
});

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const total_users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const total_credits = db
    .prepare(
      "SELECT COALESCE(SUM(cost), 0) AS s FROM consumption_records WHERE cost > 0"
    )
    .get().s;
  const today = new Date().toISOString().slice(0, 10);
  const today_users = db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE date(created_at) = date(?)")
    .get(today).c;
  const total_records = db.prepare('SELECT COUNT(*) AS c FROM consumption_records').get().c;
  const recent = db
    .prepare(
      `SELECT cr.id, cr.type, cr.cost, cr.created_at, u.username
       FROM consumption_records cr
       JOIN users u ON u.id = cr.user_id
       ORDER BY cr.id DESC LIMIT 10`
    )
    .all();
  const recent_records = recent.map((r) => ({
    username: r.username,
    type: r.type,
    cost: r.cost,
    created_at: r.created_at,
  }));
  res.json(
    ok({
      total_users,
      total_credits,
      today_users,
      total_records,
      recent_records,
    })
  );
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const users = db
    .prepare(
      'SELECT id, name, phone, username, balance, created_at FROM users ORDER BY id DESC'
    )
    .all();
  res.json(ok(users));
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.json(fail('无效用户'));
  db.prepare('DELETE FROM consumption_records WHERE user_id = ?').run(id);
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (r.changes === 0) return res.json(fail('用户不存在'));
  res.json(ok(true));
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { name, phone, balance } = req.body || {};
  if (!id) return res.json(fail('无效用户'));
  if (!name || !phone) return res.json(fail('姓名或手机号不能为空'));
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.json(fail('手机号格式不正确'));
  const bal = Number(balance);
  if (!Number.isFinite(bal) || bal < 0 || !Number.isInteger(bal)) {
    return res.json(fail('积分无效'));
  }
  const r = db
    .prepare('UPDATE users SET name = ?, phone = ?, balance = ? WHERE id = ?')
    .run(name, phone, bal, id);
  if (r.changes === 0) return res.json(fail('用户不存在'));
  res.json(ok(true));
});

app.post('/api/admin/recharge', requireAdmin, (req, res) => {
  const { user_id, amount } = req.body || {};
  const uid = Number(user_id);
  const amt = Number(amount);
  if (!uid || !amt || amt <= 0) return res.json(fail('参数错误'));
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
  if (!u) return res.json(fail('用户不存在'));
  addUserBalance(uid, amt);
  recordConsumption(uid, 'recharge', -amt);
  res.json(ok(true));
});

app.get('/api/admin/records', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT cr.id, cr.type, cr.cost, cr.created_at, u.username
       FROM consumption_records cr
       JOIN users u ON u.id = cr.user_id
       ORDER BY cr.id DESC LIMIT 500`
    )
    .all();
  res.json(ok(rows));
});

app.get('/api/admin/api-config', requireAdmin, (_req, res) => {
  res.json(ok(getApiConfig()));
});

app.post('/api/admin/api-config', requireAdmin, (req, res) => {
  const body = req.body || {};
  saveApiConfigPatch(body);
  res.json(ok(getApiConfig()));
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.json(fail('请填写完整'));
  if (new_password.length < 6) return res.json(fail('新密码至少6位'));
  const adm = getAdminUser();
  if (!bcrypt.compareSync(current_password, adm.password_hash)) {
    return res.json(fail('当前密码错误'));
  }
  setAdminUser({
    username: adm.username,
    password_hash: bcrypt.hashSync(new_password, 10),
  });
  res.json(ok(true));
});

function clearAllUploadCacheFiles() {
  let removed = 0;
  let failed = 0;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const names = fs.readdirSync(UPLOAD_DIR);
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const fp = path.join(UPLOAD_DIR, name);
    let st;
    try {
      st = fs.statSync(fp);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    try {
      fs.unlinkSync(fp);
      removed++;
    } catch (e) {
      failed++;
      console.warn('[upload-clear]', name, e.message);
    }
  }
  return { removed, failed };
}

app.post('/api/admin/uploads/clear', requireAdmin, (_req, res) => {
  try {
    const { removed, failed } = clearAllUploadCacheFiles();
    console.log(`[upload-clear] admin 清空 uploads: removed=${removed} failed=${failed}`);
    return res.json(ok({ removed, failed }));
  } catch (e) {
    return res.json(fail(e.message || '清空失败'));
  }
});

app.get('/api/admin/upload-cache-settings', requireAdmin, (_req, res) => {
  const s = getUploadCacheSettings();
  return res.json(
    ok({
      retentionHours: s.retentionHours,
      intervalMinutes: s.intervalMinutes,
    })
  );
});

app.post('/api/admin/upload-cache-settings', requireAdmin, (req, res) => {
  try {
    const next = saveUploadCacheSettings(req.body || {});
    startUploadCacheScheduler();
    return res.json(
      ok({
        retentionHours: next.retentionHours,
        intervalMinutes: next.intervalMinutes,
      })
    );
  } catch (e) {
    return res.json(fail(e.message || '保存失败'));
  }
});

app.get('/api/admin/nano-banana/usage', requireAdmin, async (req, res) => {
  try {
    const cfg = getApiConfig().image || {};
    const key = (cfg.key || '').trim();
    if (!key) return res.json(fail('请先在图片 API 中填写 Nano Banana 的 API Key'));
    const base = nanoBananaBaseUrl(cfg);
    const days = req.query.days != null ? String(req.query.days) : '7';
    const limit = req.query.limit != null ? String(req.query.limit) : '50';
    const url = `${base}/api/usage?days=${encodeURIComponent(days)}&limit=${encodeURIComponent(limit)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let r;
    try {
      r = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.json(fail(`用量接口返回非 JSON: ${text.slice(0, 160)}`));
    }
    if (!r.ok) {
      return res.json(
        fail(json.error?.message || json.message || `HTTP ${r.status}: ${text.slice(0, 160)}`)
      );
    }
    return res.json(ok(json));
  } catch (e) {
    return res.json(fail(e.name === 'AbortError' ? '用量查询超时' : e.message || '查询失败'));
  }
});

app.post('/api/canvas/generate', (req, res) => {
  const body = req.body || {};
  console.log(
    '[canvas/generate] legacy stub aspect=%s slot=%s (请改用 /api/generate/image)',
    body.aspect,
    body.grid_slot
  );
  return res.json(
    ok({
      task_id: 'canvas_' + Date.now().toString(36),
      aspect: body.aspect || '16:9',
      slot: body.grid_slot,
      yaw: body.char_yaw,
      scene_desc: body.scene_desc || '',
      message: '演示接口：资产生成节点已改为调用 /api/generate/image',
    })
  );
});

app.use('/api', (req, res) => {
  res.status(404).json(fail('接口不存在', 404));
});

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const raw = req.path || '';
  const norm = path.posix.normalize(raw);
  if (norm.includes('..')) return res.status(403).send('Forbidden');
  const base = norm.split('/').filter(Boolean)[0] || '';
  const denyRoots = new Set([
    'data',
    'node_modules',
    '.git',
    '.env',
    'server.js',
    'package.json',
    'package-lock.json',
    'docker-compose.yml',
    'Dockerfile',
    'xunyu.service',
    'deploy.ps1',
    'backup.ps1',
    'backup-remote.ps1',
  ]);
  if (denyRoots.has(base)) return res.status(403).send('Forbidden');
  next();
});

/** 根路径必须在 express.static 之前处理：static 默认 index.html 会抢先响应 GET /，导致无法落到 director */
app.get('/', (req, res) => {
  const fp = path.join(ROOT, 'director.html');
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    return res.status(500).type('text/plain; charset=utf-8').send('director.html 缺失');
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.sendFile(fp);
});

/** 旧书签 /index.html 统一到超级编导 */
app.get('/index.html', (_req, res) => {
  res.redirect(302, '/');
});

app.use(
  express.static(ROOT, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      }
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (req.method !== 'GET') return next();
  const tryFile = path.join(ROOT, req.path === '/' ? 'director.html' : req.path);
  if (fs.existsSync(tryFile) && fs.statSync(tryFile).isFile()) {
    if (tryFile.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
    return res.sendFile(tryFile);
  }
  res.status(404).send('Not found');
});

/** 避免 /api 返回 HTML（前端 resp.json() 会抛错并显示「网络异常」） */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const p = req.path || '';
  if (!p.startsWith('/api')) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json(fail('请求 JSON 无效，请刷新页面后重试'));
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json(fail('请求体过大'));
  }
  return next(err);
});

const httpRequestTimeoutMs = resolveHttpServerRequestTimeoutMs();
const server = app.listen(PORT, () => {
  migrateApiConfigLlm2DefaultOnce();
  migrateVideoC1SoundEffectOffOnce();
  migratePaiwoFastMotionIncompatibleOnce();
  console.log(`讯语AI-v1 服务已启动 http://127.0.0.1:${PORT}`);
  console.log(
    `超级编导: http://127.0.0.1:${PORT}/  · 后台: http://127.0.0.1:${PORT}/admin.html （图片上游 ${NANO_BANANA_FETCH_TIMEOUT_MS}ms · HTTP ${httpRequestTimeoutMs}ms）`
  );
  startUploadCacheScheduler();
});
server.requestTimeout = httpRequestTimeoutMs;
server.headersTimeout = httpRequestTimeoutMs + 65000;
