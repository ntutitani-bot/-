# -*- coding: utf-8 -*-
"""送付状メーカー.html から派生ファイルを生成する。

  python3 tools/build.py [公開用の出力先ディレクトリ]

生成物:
  print.html                     … 共有リンク版が新しいタブで開く印刷専用ページ（CSSとロゴを本体から取り込む）
  <出力先>/送付状メーカー.html      … claude.ai に公開する本体（外側の <html><head> を除いたもの）
  <出力先>/print.html
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN = os.path.join(ROOT, "送付状メーカー.html")

src = io.open(MAIN, encoding="utf-8").read()

# ---- 本体から CSS とロゴ・印影の定数を取り出す
m = re.search(r"<style>\n(.*?)</style>", src, re.S)
assert m, "main <style> block not found"
main_css = m.group(1)

def const(name):
    mm = re.search(r'const %s\s*=\s*"([^"]+)";' % name, src)
    assert mm, "constant %s not found" % name
    return mm.group(1)

LOGO_UK = const("LOGO_UK")
SEAL_UK = const("SEAL_UK")

PRINT_HTML = u'''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>送付状メーカー 印刷</title>
<style>
%(css)s
/* ============================================================
   印刷専用ページ（送付状メーカー本体から開かれる）
   ============================================================ */
html,body{margin:0;padding:0;background:#fff}
.sheet,.env{box-shadow:none !important;zoom:1 !important;margin:0 !important}
#pbar{
  position:fixed;left:0;top:0;right:0;z-index:9;display:flex;gap:10px;align-items:center;flex-wrap:wrap;
  padding:10px 16px;background:#211613;color:#fff;
  font:13px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;
}
#pbar #pmsg{flex:1 1 260px}
#pbar kbd{
  display:inline-block;padding:1px 7px;margin:0 1px;border-radius:4px;background:#fff;color:#211613;
  font:700 12px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans",Meiryo,sans-serif;
}
#pbar button{padding:6px 14px;border:0;border-radius:5px;background:#D1352F;color:#fff;font:inherit;font-weight:700;cursor:pointer}
#pbar button.x{background:transparent;border:1px solid rgba(255,255,255,.45);font-weight:400}
#pbar.key{background:#D1352F}
#pbar.key kbd{color:#D1352F}
#empty{margin:120px 16px;text-align:center;color:#5d534e;font:14px/1.8 -apple-system,BlinkMacSystemFont,"Hiragino Sans",Meiryo,sans-serif}
@media screen{
  body{background:#eceae6;padding:72px 16px 24px}
  .sheet,.env{margin:0 auto !important;box-shadow:0 8px 30px rgba(0,0,0,.18) !important}
}
@media print{#pbar,#empty{display:none !important}}
</style>
<style id="pageStyle">@page{size:A4;margin:0}</style>
</head>
<body>
<div id="pbar">
  <span id="pmsg">印刷画面を開いています…</span>
  <button type="button" id="pbtn">印刷画面を開く</button>
  <button type="button" class="x" id="pcls">閉じる</button>
</div>
<main id="paper"></main>
<p id="empty" hidden>印刷するものがありません。送付状メーカーの「印刷」ボタンから開いてください。</p>
<script>
(function(){
"use strict";
const LOGO_UK = "%(logo)s";
const SEAL_UK = "%(seal)s";
const $ = id => document.getElementById(id);

function fromB64Url(s){
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while(s.length %% 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}
/* 本体が渡した内容を受け取る。同じ保存領域（localStorage）を優先し、URLの末尾（#）は予備 */
function load(){
  let raw = null;
  try{ raw = localStorage.getItem("soufujo:print"); }catch(e){ raw = null; }
  if(raw){
    try{ const p = JSON.parse(raw); if(p && p.html && Date.now() - (p.at || 0) < 5 * 60 * 1000) return p; }catch(e){}
  }
  const h = location.hash.replace(/^#/, "");
  if(h.length > 20){
    try{ const p = JSON.parse(fromB64Url(h)); if(p && p.html) return p; }catch(e){}
  }
  return null;
}
/* 受け取ったHTMLは用紙の中身だけを許可して組み立て直す（スクリプト等は通さない） */
const TAGS  = new Set(["DIV","SPAN","P","B","I","IMG","TABLE","THEAD","TBODY","TR","TH","TD","HEADER","FOOTER","BR","SMALL"]);
const ATTRS = new Set(["class","id","style","alt","width","height"]);
function clean(node, out){
  Array.from(node.childNodes).forEach(c=>{
    if(c.nodeType === 3){ out.appendChild(document.createTextNode(c.nodeValue)); return; }
    if(c.nodeType !== 1 || !TAGS.has(c.tagName)) return;
    const el = document.createElement(c.tagName.toLowerCase());
    Array.from(c.attributes).forEach(a=>{
      if(ATTRS.has(a.name)) el.setAttribute(a.name, a.value);
      else if(a.name === "src" && c.tagName === "IMG"){
        const v = a.value;
        if(v === "@builtin-logo") el.src = LOGO_UK;
        else if(v === "@builtin-seal") el.src = SEAL_UK;
        else if(/^data:image\\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+\\/=]+$/.test(v)) el.src = v;
      }
    });
    clean(c, el);
    out.appendChild(el);
  });
}

const p = load();
if(!p){ $("empty").hidden = false; $("pbar").hidden = true; return; }
document.title = p.title || "送付状";
$("pageStyle").textContent = "@page{size:" + (/^[A-Za-z0-9 .]+$/.test(p.page || "") ? p.page : "A4") + ";margin:0}";
clean(new DOMParser().parseFromString(p.html, "text/html").body, $("paper"));
try{ localStorage.setItem("soufujo:print:ack", String(Date.now())); }catch(e){}

/* 印刷画面を出す。出せない環境（claude.ai の制限を引き継いだタブ）ではキー操作を案内する */
let fired = false;
const bar = $("pbar"), msg = $("pmsg"), btn = $("pbtn");
window.addEventListener("beforeprint", ()=>{
  fired = true; bar.className = ""; btn.hidden = true;
  msg.textContent = "印刷またはキャンセルすると、このタブは自動で閉じます。";
});
window.addEventListener("afterprint", ()=>{ setTimeout(()=>{ try{ window.close(); }catch(e){} }, 400); });
function go(){ try{ window.print(); }catch(e){} }
btn.onclick = go;
$("pcls").onclick = ()=>{ try{ window.close(); }catch(e){} };
document.addEventListener("keydown", e=>{ if(e.key === "Escape"){ try{ window.close(); }catch(x){} } });
function start(){
  setTimeout(()=>{
    go();
    setTimeout(()=>{
      if(fired) return;
      bar.className = "key"; btn.hidden = true;
      msg.innerHTML = "このタブではキーボードの <kbd>Ctrl</kbd>+<kbd>P</kbd>（Macは <kbd>\\u2318</kbd>+<kbd>P</kbd>）で印刷画面が開きます。";
    }, 700);
  }, 250);
}
if(document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
</script>
</body>
</html>
'''

print_html = PRINT_HTML % {"css": main_css, "logo": LOGO_UK, "seal": SEAL_UK}
io.open(os.path.join(ROOT, "print.html"), "w", encoding="utf-8").write(print_html)
print("print.html:", len(print_html.encode("utf-8")), "bytes")

# ---- Google Apps Script 版：本体そのものを index.html として置く（Code.gs と一緒に貼り付ける）
os.makedirs(os.path.join(ROOT, "gas"), exist_ok=True)
io.open(os.path.join(ROOT, "gas", "index.html"), "w", encoding="utf-8").write(src)
print("gas/index.html:", len(src.encode("utf-8")), "bytes")

# ---- claude.ai 公開用：外側の <html><head> を外した本体
if len(sys.argv) > 1:
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    head = "<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    tail = "</body>\n</html>\n"
    assert src.startswith(head) and src.endswith(tail)
    body = src[len(head):-len(tail)]
    assert body.lstrip().startswith("<title>")
    io.open(os.path.join(out_dir, "送付状メーカー.html"), "w", encoding="utf-8").write(body)
    io.open(os.path.join(out_dir, "print.html"), "w", encoding="utf-8").write(print_html)
    print("artifact files written to", out_dir)
