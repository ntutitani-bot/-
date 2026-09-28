/**
 * 送付状メーカー — Google Apps Script 版（サーバー側）
 *
 * - 画面（HTML）は GitHub 上の gas/index.html を起動時に取り込んで配信する。
 *   取り込んだ内容は 10 分間キャッシュし、控えをドライブにも保存するので、
 *   GitHub に届かないときは控えで動く。画面の更新は GitHub 側を直すだけで反映される。
 * - 共有データ（差出人・担当者・アドレス帳・書類候補・送付履歴）は、このスクリプトの所有者の
 *   Google ドライブ内「送付状メーカー」フォルダの JSON ファイル 1 つに保存する
 * - 更新は項目ごとの操作（op）で受け取り、LockService で直列化するので、複数人が同時に使っても
 *   互いの変更を消さない
 *
 * 公開のしかた：デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *   次のユーザーとして実行「自分」／アクセスできるユーザー「（組織名）内の全員」
 */

var APP_SOURCE_URL  = "https://raw.githubusercontent.com/ntutitani-bot/-/claude/delivery-note-maker-improve-h89eud/gas/index.html";
var FOLDER_NAME     = "送付状メーカー";
var DATA_FILE       = "送付状メーカー_data.json";
var APP_BACKUP_FILE = "送付状メーカー_app.html";
var CACHE_SEC       = 600;     // 画面のキャッシュ時間（秒）
var CHUNK           = 30000;   // キャッシュは 1 件 100KB までなので分割する
var HISTORY_MAX     = 500;
var CONTACTS_MAX    = 1000;

/* ---------- 配信 ---------- */
function doGet() {
  var html = appHtml_();
  if (!html) {
    return HtmlService.createHtmlOutput(
      "<!doctype html><meta charset=\"utf-8\"><p style=\"font-family:sans-serif;padding:24px;line-height:1.8\">" +
      "送付状メーカーの画面を読み込めませんでした。<br>しばらくしてから開き直してください。</p>"
    ).setTitle("送付状メーカー");
  }
  return HtmlService.createHtmlOutput(html)
    .setTitle("送付状メーカー")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function appHtml_() {
  var cache = CacheService.getScriptCache();
  var cached = cacheGet_(cache);
  if (cached) return cached;
  var html = fetchApp_();
  if (html) {
    cachePut_(cache, html);
    try { backupPut_(html); } catch (e) { /* 控えの保存に失敗しても配信は続ける */ }
    return html;
  }
  var backup = backupGet_();
  if (backup) cachePut_(cache, backup);
  return backup;
}
function fetchApp_() {
  try {
    var res = UrlFetchApp.fetch(APP_SOURCE_URL, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return null;
    var html = res.getContentText("UTF-8");
    return (html && html.indexOf("送付状メーカー") >= 0 && html.indexOf("</html>") > 0) ? html : null;
  } catch (e) {
    return null;
  }
}
function cacheGet_(cache) {
  try {
    var n = Number(cache.get("app:n") || 0);
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push("app:" + i);
    var parts = cache.getAll(keys), out = "";
    for (var j = 0; j < n; j++) {
      if (!parts["app:" + j]) return null;
      out += parts["app:" + j];
    }
    return out;
  } catch (e) {
    return null;
  }
}
function cachePut_(cache, html) {
  try {
    var obj = {}, n = 0;
    for (var i = 0; i < html.length; i += CHUNK) { obj["app:" + n] = html.substring(i, i + CHUNK); n++; }
    obj["app:n"] = String(n);
    cache.putAll(obj, CACHE_SEC);
  } catch (e) { /* キャッシュできなくても動く */ }
}
function backupGet_() {
  try {
    var f = backupFile_();
    return f ? f.getBlob().getDataAsString("UTF-8") : null;
  } catch (e) {
    return null;
  }
}
function backupPut_(html) {
  var props = PropertiesService.getScriptProperties();
  var h = md5_(html);
  if (props.getProperty("appHash") === h) return;
  var f = backupFile_();
  if (f) f.setContent(html);
  else {
    f = folder_().createFile(APP_BACKUP_FILE, html, MimeType.HTML);
    props.setProperty("appFileId", f.getId());
  }
  props.setProperty("appHash", h);
}
function backupFile_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("appFileId");
  if (id) {
    try { var f = DriveApp.getFileById(id); if (!f.isTrashed()) return f; } catch (e) { /* 作り直す */ }
  }
  var it = folder_().getFilesByName(APP_BACKUP_FILE);
  if (!it.hasNext()) return null;
  var file = it.next();
  props.setProperty("appFileId", file.getId());
  return file;
}
function md5_(s) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  return d.map(function (b) { b = (b + 256) % 256; return (b < 16 ? "0" : "") + b.toString(16); }).join("");
}

/* ---------- クライアントから呼ばれる関数 ---------- */

/** 共有データをまとめて返す（起動時と定期更新） */
function load() {
  return result_(read_());
}

/** 共有データを 1 操作ぶん更新し、更新後の全体を返す */
function mutate(op, payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var d = read_();
    apply_(d, op, payload || {}, userEmail_());
    write_(d);
    return result_(d);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 操作の適用 ---------- */
function apply_(d, op, p, user) {
  switch (op) {
    case "sender.update": {
      if (!p.id) throw new Error("sender.update: id がありません");
      var s = senderById_(d, p.id);
      if (!s) { s = { id: String(p.id), staff: [] }; d.senders.push(s); }
      var fields = p.fields || {};
      ["name", "zip", "addr", "tel", "accent", "logoW", "logo", "seal", "logoCleared", "sealCleared"].forEach(function (k) {
        if (!(k in fields)) return;
        var v = fields[k];
        if (v === null || v === undefined || v === false) delete s[k];
        else s[k] = (k === "logoCleared" || k === "sealCleared") ? true : String(v);
      });
      break;
    }
    case "staff.add": {
      var sa = needSender_(d, p.senderId);
      var name = String(p.name || "").trim();
      if (!name) throw new Error("staff.add: 氏名がありません");
      if (!sa.staff.some(function (x) { return x.name === name; })) {
        sa.staff.push({ id: String(p.staffId || uid_()), name: name, tel: String(p.tel || "").trim() });
      }
      break;
    }
    case "staff.update": {
      var su = needSender_(d, p.senderId);
      var st = su.staff.filter(function (x) { return x.id === String(p.staffId); })[0];
      if (!st) { st = { id: String(p.staffId || uid_()) }; su.staff.push(st); }
      if ("name" in p) st.name = String(p.name || "");
      if ("tel" in p) st.tel = String(p.tel || "");
      break;
    }
    case "staff.remove": {
      var sr = needSender_(d, p.senderId);
      sr.staff = sr.staff.filter(function (x) { return x.id !== String(p.staffId); });
      break;
    }
    case "contact.save": {
      var c = cleanContact_(p.contact);
      if (!c) throw new Error("contact.save: 宛先が空です");
      d.contacts = [c].concat(d.contacts.filter(function (x) { return x.key !== c.key; })).slice(0, CONTACTS_MAX);
      break;
    }
    case "contact.remove": {
      d.contacts = d.contacts.filter(function (x) { return x.key !== String(p.key); });
      break;
    }
    case "docNames.set": {
      d.docNames = strList_(p.docNames);
      break;
    }
    case "history.add": {
      var h = p.entry && typeof p.entry === "object" ? p.entry : null;
      if (!h) throw new Error("history.add: entry がありません");
      h.by = user || "";
      h.at = Number(h.at) || Date.now();
      d.history = [h].concat(d.history).slice(0, HISTORY_MAX);
      break;
    }
    case "import": {
      /* 設定ファイルの読み込み：差出人・書類候補は置き換え、アドレス帳は追加（同じ宛先は上書き） */
      if (Array.isArray(p.senders) && p.senders.length) {
        d.senders = p.senders.map(function (x) { return cleanSender_(x); }).filter(Boolean);
      }
      if (Array.isArray(p.docNames) && p.docNames.length) d.docNames = strList_(p.docNames);
      if (Array.isArray(p.contacts)) {
        var map = {};
        d.contacts.forEach(function (x) { map[x.key] = x; });
        p.contacts.forEach(function (x) { var cc = cleanContact_(x); if (cc) map[cc.key] = cc; });
        d.contacts = Object.keys(map).map(function (k) { return map[k]; }).slice(0, CONTACTS_MAX);
      }
      break;
    }
    default:
      throw new Error("不明な操作です: " + op);
  }
}

/* ---------- 保存先（ドライブ内の JSON ファイル） ---------- */
function folder_() {
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}
function file_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("dataFileId");
  if (id) {
    try { var f = DriveApp.getFileById(id); if (!f.isTrashed()) return f; } catch (e) { /* 削除済みなら作り直す */ }
  }
  var folder = folder_();
  var files = folder.getFilesByName(DATA_FILE);
  var file = files.hasNext() ? files.next() : folder.createFile(DATA_FILE, JSON.stringify(empty_()), MimeType.PLAIN_TEXT);
  props.setProperty("dataFileId", file.getId());
  return file;
}
function read_() {
  var d = null;
  try { d = JSON.parse(file_().getBlob().getDataAsString("UTF-8")); } catch (e) { d = null; }
  return normalize_(d);
}
function write_(d) {
  file_().setContent(JSON.stringify(d));
}

/* ---------- 整形 ---------- */
function empty_() { return { v: 1, senders: [], contacts: [], history: [], docNames: [] }; }
function normalize_(d) {
  var out = empty_();
  if (!d || typeof d !== "object") return out;
  out.senders  = (Array.isArray(d.senders) ? d.senders : []).map(cleanSender_).filter(Boolean);
  out.contacts = (Array.isArray(d.contacts) ? d.contacts : []).map(cleanContact_).filter(Boolean).slice(0, CONTACTS_MAX);
  out.history  = (Array.isArray(d.history) ? d.history : []).filter(function (h) { return h && typeof h === "object"; }).slice(0, HISTORY_MAX);
  out.docNames = strList_(d.docNames);
  return out;
}
function cleanSender_(x) {
  if (!x || typeof x !== "object" || !x.id) return null;
  var s = { id: String(x.id), staff: [] };
  ["name", "zip", "addr", "tel", "accent", "logoW", "logo", "seal"].forEach(function (k) { if (x[k]) s[k] = String(x[k]); });
  if (x.logoCleared) s.logoCleared = true;
  if (x.sealCleared) s.sealCleared = true;
  var seen = {};
  (Array.isArray(x.staff) ? x.staff : []).forEach(function (st) {
    if (typeof st === "string") st = { name: st, tel: "" };
    if (!st || typeof st !== "object") return;
    var name = String(st.name || "").trim(), tel = String(st.tel || "").trim();
    if (!name && !tel) return;
    if (seen[name]) return;
    seen[name] = true;
    s.staff.push({ id: String(st.id || uid_()), name: name, tel: tel });
  });
  return s;
}
function cleanContact_(x) {
  if (!x || typeof x !== "object") return null;
  var c = {};
  ["company", "dept", "title", "name", "honor", "zip", "addr"].forEach(function (k) { c[k] = String(x[k] || ""); });
  if (!c.company.trim() && !c.name.trim()) return null;
  c.key = x.key ? String(x.key) : [c.company, c.dept, c.title, c.name].join("|");
  return c;
}
function strList_(v) {
  return (Array.isArray(v) ? v : []).map(function (x) { return String(x || "").trim(); }).filter(Boolean).slice(0, 200);
}
function senderById_(d, id) {
  return d.senders.filter(function (x) { return x.id === String(id); })[0] || null;
}
function needSender_(d, id) {
  var s = senderById_(d, id);
  if (!s) { s = { id: String(id), staff: [] }; d.senders.push(s); }
  if (!Array.isArray(s.staff)) s.staff = [];
  return s;
}
function uid_() {
  return Utilities.getUuid().replace(/-/g, "").slice(0, 12);
}
function userEmail_() {
  try { return Session.getActiveUser().getEmail() || ""; } catch (e) { return ""; }
}
function result_(d) {
  return { data: d, user: userEmail_(), at: Date.now() };
}
