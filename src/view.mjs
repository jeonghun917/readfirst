// The map as one self-contained HTML page: groups as areas sized by their files, files as tiles, files under a risk
// marked, files a rule covers outlined. Pointing at a tile shows what to read before changing that file. No network,
// no dependencies: the data and the drawing code are inlined.
import { groupOf, matcher } from './map.mjs';
import { readList } from './readlist.mjs';

const esc = (s) => String(s).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// What the page needs, per file: its group, its read list in short form, and its marks.
export function viewData({ map, files, imports, name = 'repository', limit = 5 }) {
  const placed = files.filter((f) => groupOf(map, f));
  const byGroup = new Map(map.groups.map((g) => [g.id, []]));
  const fileRows = {};
  for (const f of placed) {
    const g = groupOf(map, f);
    byGroup.get(g.id).push(f);
    const list = readList({ map, files, imports, targets: [f], limit });
    fileRows[f] = {
      g: g.id,
      rules: list.rules.map((r) => [r.id, r.rule, r.why ?? '']),
      risks: list.risks.map((r) => r.text),
      checks: list.checks.map((c) => [c.run, c.why ?? '']),
      tests: list.tests.map((t) => t.path),
      users: list.usedBy.length + list.usedByIndirectly,
      // A risk "on" a file: one that names the file, not one that covers its whole group.
      own: (g.risks ?? []).filter((r) => r.files && matcher(r.files)(f)).length,
    };
  }
  const links = new Map();
  for (const e of imports) {
    const a = fileRows[e.from]?.g; const b = fileRows[e.to]?.g;
    if (!a || !b || a === b) continue;
    const key = [a, b].sort().join('\0');
    links.set(key, (links.get(key) ?? 0) + 1);
  }
  return {
    name,
    links: [...links].map(([k, n]) => { const [a, b] = k.split('\0'); return { a, b, n }; }),
    groups: map.groups.map((g) => ({ id: g.id, title: g.title, files: byGroup.get(g.id) ?? [], risks: (g.risks ?? []).length, checks: (g.checks ?? []).length })).filter((g) => g.files.length),
    rules: (map.rules ?? []).length,
    files: fileRows,
  };
}

export function viewHtml(data) {
  const json = JSON.stringify(data).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.name)}: what to read before you change a file</title>
<style>
:root{--bg:#0d1117;--panel:#11161d;--fg:#e6edf3;--muted:#8b949e;--line:#262c36;--risk:#ff6b5e;--rule:#e3b341;--check:#7ee787;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);display:grid;grid-template-rows:auto 1fr;}
header{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;padding:14px 18px;border-bottom:1px solid var(--line)}
h1{font:600 16px var(--mono);margin:0}h1 span{color:var(--muted);font-weight:400}
.legend{display:flex;gap:16px;font:12px var(--mono);color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px;border-radius:2px}
main{display:grid;grid-template-columns:1fr 380px;min-height:0}
#map{position:relative;margin:12px;min-height:420px}
.group{position:absolute;border:1px solid rgba(255,255,255,.08);border-radius:4px;overflow:hidden}
.gh{position:absolute;left:0;right:0;top:0;height:22px;padding:3px 7px;font:600 11px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(0,0,0,.28)}
.gh b{color:var(--risk);font-weight:600;margin-left:6px}
.tile{position:absolute;border-radius:2px;cursor:pointer;transition:transform .08s}
.tile:hover,.tile.on{outline:2px solid #fff;z-index:2}
.tile.rule{box-shadow:inset 0 0 0 2px var(--rule)}
.lbl{position:absolute;left:5px;top:3px;right:4px;font:11px var(--mono);color:rgba(255,255,255,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.tile.own::after{content:"";position:absolute;right:2px;top:2px;width:6px;height:6px;border-radius:50%;background:var(--risk)}
aside{border-left:1px solid var(--line);background:var(--panel);padding:16px 18px;overflow:auto}
aside h2{font:600 13px var(--mono);margin:0 0 4px;word-break:break-all}aside .sub{color:var(--muted);font:12px var(--mono);margin-bottom:14px}
aside h3{font:600 12px var(--mono);margin:16px 0 6px;color:#79c0ff}aside ul{margin:0;padding-left:16px}aside li{margin:3px 0}
.r{color:var(--rule);font-family:var(--mono)}.k{color:var(--check);font-family:var(--mono)}.w{color:var(--risk)}
.hint{color:var(--muted)}
footer{grid-column:1/-1;padding:8px 18px;border-top:1px solid var(--line);font:12px var(--mono);color:var(--muted)}footer a{color:inherit}
@media (max-width:820px){main{grid-template-columns:1fr}aside{border-left:0;border-top:1px solid var(--line)}#map{min-height:520px}}
</style></head><body>
<header><h1>${esc(data.name)} <span>· what to read before you change a file</span></h1>
<div class="legend"><span><i style="background:linear-gradient(90deg,hsl(215 35% 22%),hsl(110 58% 31%),hsl(0 80% 42%));width:40px"></i>how much to read first</span><span><i style="background:var(--risk);border-radius:50%"></i>risk on this file</span><span><i style="box-shadow:inset 0 0 0 2px var(--rule)"></i>a rule covers it</span></div></header>
<main><div id="map"></div><aside id="side"><p class="hint">Point at a file to see what to read and check before changing it.</p></aside></main>
<footer>Made with <a href="https://github.com/jeonghun917/readfirst">readfirst</a> from .readfirst/map.json</footer>
<script>
const D=${json};
const hues=[205,150,35,280,0,95,320,180,60,240,15,120];
const color=(i,l)=>'hsl('+hues[i%hues.length]+' 45% '+l+'%)';
function squarify(items,x,y,w,h){ // items: [{v,...}] sorted desc; returns [{...,x,y,w,h}]
  const out=[];let rest=items.slice();
  while(rest.length){const total=rest.reduce((s,i)=>s+i.v,0);const short=Math.min(w,h);let row=[],best=Infinity;
    for(const it of rest){const r=[...row,it];const s=r.reduce((a,b)=>a+b.v,0);const side=s/total*(w>=h?w:h);
      const worst=Math.max(...r.map(q=>{const len=q.v/s*short;return Math.max(side/len,len/side)}));
      if(worst>best)break;best=worst;row=r}
    const s=row.reduce((a,b)=>a+b.v,0);const frac=s/total;
    if(w>=h){const rw=w*frac;let yy=y;for(const it of row){const hh=h*it.v/s;out.push({...it,x,y:yy,w:rw,h:hh});yy+=hh}x+=rw;w-=rw}
    else{const rh=h*frac;let xx=x;for(const it of row){const ww=w*it.v/s;out.push({...it,x:xx,y,w:ww,h:rh});xx+=ww}y+=rh;h-=rh}
    rest=rest.slice(row.length)}
  return out}
const map=document.getElementById('map'),side=document.getElementById('side');
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
function show(f){const r=D.files[f];const g=D.groups.find(x=>x.id===r.g);
  document.querySelectorAll('.tile.on').forEach(t=>t.classList.remove('on'));
  const t=document.querySelector('[data-f="'+CSS.escape(f)+'"]');if(t)t.classList.add('on');
  let h='<h2>'+esc(f)+'</h2><div class="sub">group '+esc(g.id)+' · '+esc(g.title)+(r.users?' · used by '+r.users+' file'+(r.users>1?'s':''):'')+'</div>';
  if(r.rules.length)h+='<h3>## Rules that must keep holding</h3><ul>'+r.rules.map(x=>'<li><span class="r">'+esc(x[0])+'</span>: '+esc(x[1])+(x[2]?' <span class="hint">— why: '+esc(x[2])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.risks.length)h+='<h3>## Watch out</h3><ul>'+r.risks.map(x=>'<li class="w">'+esc(x)+'</li>').join('')+'</ul>';
  if(r.checks.length)h+='<h3>## Run these checks</h3><ul>'+r.checks.map(x=>'<li><span class="k">'+esc(x[0])+'</span>'+(x[1]?' <span class="hint">— '+esc(x[1])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.tests.length)h+='<h3>## Tests that reach this code</h3><ul>'+r.tests.map(x=>'<li class="k">'+esc(x)+'</li>').join('')+'</ul>';
  if(!r.rules.length&&!r.risks.length&&!r.checks.length&&!r.tests.length)h+='<p class="hint">Nothing in the map is tied to this file yet.</p>';
  side.innerHTML=h}
// Heat: how much there is to read before touching a file. Rules count most, a risk on the file next, group-wide risks a little.
const heatOf=r=>r.rules.length*2+r.own*3+r.risks.length;
const maxHeat=Math.max(1,...Object.values(D.files).map(heatOf));
const heatColor=h=>{const t=Math.pow(h/maxHeat,.7);return 'hsl('+(215-215*t)+' '+(35+45*t)+'% '+(22+20*t)+'%)'};
function draw(){map.innerHTML='';const W=map.clientWidth,H=Math.max(map.clientHeight,420);
  // Groups get room by importance, not by file count, so a small core is not drowned by a big test folder.
  const gs=D.groups.map((g,i)=>{const heat=g.files.reduce((s,f)=>s+heatOf(D.files[f]),0);return {...g,i,v:Math.sqrt(g.files.length)*(1+heat/Math.max(1,g.files.length))}}).sort((a,b)=>b.v-a.v);
  for(const g of squarify(gs,0,0,W,H)){const el=document.createElement('div');el.className='group';
    Object.assign(el.style,{left:g.x+2+'px',top:g.y+2+'px',width:g.w-4+'px',height:g.h-4+'px',background:'#0a0d12'});
    el.innerHTML='<div class="gh" title="'+esc(g.title)+'">'+esc(g.id)+'<span class="hint"> · '+g.files.length+'</span>'+(g.risks?'<b>'+g.risks+' risk'+(g.risks>1?'s':'')+'</b>':'')+'</div>';map.appendChild(el);
    const iw=g.w-8,ih=g.h-30;if(iw<6||ih<6)continue;
    // Files get room by how much depends on them and how much the map says about them.
    const fs=g.files.map(f=>{const r=D.files[f];return {f,r,v:1+Math.sqrt(r.users)+heatOf(r)}}).sort((a,b)=>b.v-a.v);
    for(const t of squarify(fs,0,0,iw,ih)){const el2=document.createElement('div');el2.className='tile'+(t.r.rules.length?' rule':'')+(t.r.own?' own':'');el2.dataset.f=t.f;el2.title=t.f;
      Object.assign(el2.style,{left:4+t.x+1+'px',top:26+t.y+1+'px',width:Math.max(t.w-2,1)+'px',height:Math.max(t.h-2,1)+'px',background:heatColor(heatOf(t.r))});
      if(t.w>70&&t.h>20){const base=t.f.split('/').pop();el2.innerHTML='<span class="lbl">'+esc(base)+'</span>'}
      el2.onmouseenter=()=>show(t.f);el2.onclick=()=>show(t.f);el.appendChild(el2)}}}
draw();addEventListener('resize',draw);
const first=Object.keys(D.files).sort((a,b)=>(D.files[b].risks.length+D.files[b].rules.length)-(D.files[a].risks.length+D.files[a].rules.length))[0];if(first)show(first);
</script></body></html>`;
}

// The same data as a small 3D city: a building per file, footprint from the treemap, height from how much depends on it.
// Light by traffic-light rule: red where the map names a risk on the file, amber where a rule covers it, blue otherwise.
export function viewHtml3d(data) {
  const json = JSON.stringify(data).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.name)}: what to read before you change a file</title>
<style>
:root{--bg:#06080c;--panel:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#1f2630;--red:#ff4d3d;--amber:#ffbf3c;--blue:#3d8bff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:radial-gradient(ellipse at 50% 35%,#101826 0%,var(--bg) 70%);color:var(--fg);font:14px/1.5 var(--sans);display:grid;grid-template-rows:auto 1fr;overflow:hidden}
header{display:flex;flex-wrap:wrap;gap:6px 22px;align-items:baseline;padding:14px 18px;border-bottom:1px solid var(--line);position:relative;z-index:3;background:rgba(6,8,12,.7)}
h1{font:600 16px var(--mono);margin:0}h1 span{color:var(--muted);font-weight:400}
.legend{display:flex;gap:16px;font:12px var(--mono);color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}
main{display:grid;grid-template-columns:1fr 380px;min-height:0}
#stage{position:relative;overflow:hidden;perspective:2200px;cursor:grab}#stage:active{cursor:grabbing}
#world{position:absolute;left:50%;top:54%;width:900px;height:900px;margin:-450px 0 0 -450px;transform-style:preserve-3d;transition:transform .05s linear}
.lot{position:absolute;transform-style:preserve-3d;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06)}
.lot .name{position:absolute;left:4px;top:-20px;font:600 12px var(--mono);color:#c9d1d9;white-space:nowrap;transform:translateZ(1px)}
.b{position:absolute;transform-style:preserve-3d;cursor:pointer}
.b>i{position:absolute;display:block}
.b .top{inset:0}
.b .s,.b .n{left:0;width:100%;transform-origin:top;transform:rotateX(90deg)}.b .n{top:0}
.b .e,.b .w{top:0;height:100%;transform-origin:left;transform:rotateY(-90deg)}.b .w{left:0}
.b.red .top{background:#ff6a5c;box-shadow:0 0 18px 4px rgba(255,77,61,.75),0 0 60px 10px rgba(255,77,61,.35)}.b.red .s,.b.red .n{background:#b8291d}.b.red .e,.b.red .w{background:#8e1d14}
.b.amber .top{background:#ffd06a;box-shadow:0 0 14px 3px rgba(255,191,60,.6),0 0 40px 6px rgba(255,191,60,.25)}.b.amber .s,.b.amber .n{background:#b9851a}.b.amber .e,.b.amber .w{background:#8c6413}
.b.blue .top{background:#4a92ff;box-shadow:0 0 8px 1px rgba(61,139,255,.45)}.b.blue .s,.b.blue .n{background:#1f4f9e}.b.blue .e,.b.blue .w{background:#173c7a}
.b.on .top{background:#fff!important}
aside{border-left:1px solid var(--line);background:var(--panel);padding:16px 18px;overflow:auto;position:relative;z-index:3}
aside h2{font:600 13px var(--mono);margin:0 0 4px;word-break:break-all}aside .sub{color:var(--muted);font:12px var(--mono);margin-bottom:12px}
aside h3{font:600 12px var(--mono);margin:16px 0 6px;color:#79c0ff}aside ul{margin:0;padding-left:16px}aside li{margin:3px 0}
.r{color:var(--amber);font-family:var(--mono)}.k{color:#7ee787;font-family:var(--mono)}.w{color:#ff7b70}.hint{color:var(--muted)}
.tip{position:absolute;left:16px;bottom:12px;font:12px var(--mono);color:var(--muted);z-index:3}
@media (max-width:820px){body{overflow:auto}main{grid-template-columns:1fr}#stage{height:70vh}aside{border-left:0;border-top:1px solid var(--line)}}
</style></head><body>
<header><h1>${esc(data.name)} <span>· what to read before you change a file</span></h1>
<div class="legend"><span><i style="background:var(--red);box-shadow:0 0 8px var(--red)"></i>a risk on this file</span><span><i style="background:var(--amber);box-shadow:0 0 8px var(--amber)"></i>a rule covers it</span><span><i style="background:var(--blue)"></i>nothing to watch</span></div></header>
<main><div id="stage"><div id="world"></div><div class="tip">drag to turn · point at a building</div></div><aside id="side"></aside></main>
<script>
const D=${json};
function squarify(items,x,y,w,h){const out=[];let rest=items.slice();
  while(rest.length){const total=rest.reduce((s,i)=>s+i.v,0);const short=Math.min(w,h);let row=[],best=Infinity;
    for(const it of rest){const r=[...row,it];const s=r.reduce((a,b)=>a+b.v,0);const side=s/total*(w>=h?w:h);
      const worst=Math.max(...r.map(q=>{const len=q.v/s*short;return Math.max(side/len,len/side)}));if(worst>best)break;best=worst;row=r}
    const s=row.reduce((a,b)=>a+b.v,0);const frac=s/total;
    if(w>=h){const rw=w*frac;let yy=y;for(const it of row){const hh=h*it.v/s;out.push({...it,x,y:yy,w:rw,h:hh});yy+=hh}x+=rw;w-=rw}
    else{const rh=h*frac;let xx=x;for(const it of row){const ww=w*it.v/s;out.push({...it,x:xx,y,w:ww,h:rh});xx+=ww}y+=rh;h-=rh}
    rest=rest.slice(row.length)}return out}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const light=r=>r.own?'red':r.rules.length?'amber':'blue';
const weight=r=>r.rules.length*2+r.own*3+r.risks.length;
const world=document.getElementById('world'),side=document.getElementById('side');
function show(f){const r=D.files[f];const g=D.groups.find(x=>x.id===r.g);
  document.querySelectorAll('.b.on').forEach(t=>t.classList.remove('on'));const t=document.querySelector('[data-f="'+CSS.escape(f)+'"]');if(t)t.classList.add('on');
  let h='<h2>'+esc(f)+'</h2><div class="sub">'+esc(g.id)+' · '+esc(g.title)+(r.users?' · used by '+r.users+' file'+(r.users>1?'s':''):'')+'</div>';
  if(r.risks.length)h+='<h3>## Watch out</h3><ul>'+r.risks.map(x=>'<li class="w">'+esc(x)+'</li>').join('')+'</ul>';
  if(r.rules.length)h+='<h3>## Rules that must keep holding</h3><ul>'+r.rules.map(x=>'<li><span class="r">'+esc(x[0])+'</span>: '+esc(x[1])+(x[2]?' <span class="hint">— why: '+esc(x[2])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.checks.length)h+='<h3>## Run these checks</h3><ul>'+r.checks.map(x=>'<li><span class="k">'+esc(x[0])+'</span>'+(x[1]?' <span class="hint">— '+esc(x[1])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.tests.length)h+='<h3>## Tests that reach this code</h3><ul>'+r.tests.map(x=>'<li class="k">'+esc(x)+'</li>').join('')+'</ul>';
  if(!r.risks.length&&!r.rules.length&&!r.checks.length&&!r.tests.length)h+='<p class="hint">Nothing in the map is tied to this file yet.</p>';
  side.innerHTML=h}
const S=900,GAP=26;
const gs=D.groups.map((g)=>{const heat=g.files.reduce((s,f)=>s+weight(D.files[f]),0);return {...g,v:Math.sqrt(g.files.length)*(1+heat/Math.max(1,g.files.length))}}).sort((a,b)=>b.v-a.v);
const maxUsers=Math.max(1,...Object.values(D.files).map(r=>r.users+weight(r)*2));
for(const g of squarify(gs,0,0,S,S)){const lot=document.createElement('div');lot.className='lot';
  Object.assign(lot.style,{left:g.x+GAP/2+'px',top:g.y+GAP/2+'px',width:g.w-GAP+'px',height:g.h-GAP+'px'});
  lot.innerHTML='<span class="name">'+esc(g.id)+'</span>';world.appendChild(lot);
  const iw=g.w-GAP-8,ih=g.h-GAP-8;if(iw<4||ih<4)continue;
  const fs=g.files.map(f=>{const r=D.files[f];return {f,r,v:1+Math.sqrt(r.users)+weight(r)}}).sort((a,b)=>b.v-a.v);
  for(const t of squarify(fs,0,0,iw,ih)){const pad=Math.max(1.5,Math.min(t.w,t.h)*.12);const w=t.w-pad*2,d=t.h-pad*2;if(w<1||d<1)continue;
    const H=Math.round(8+150*Math.sqrt((t.r.users+weight(t.r)*2)/maxUsers));
    const b=document.createElement('div');b.className='b '+light(t.r);b.dataset.f=t.f;b.title=t.f;
    Object.assign(b.style,{left:4+t.x+pad+'px',top:4+t.y+pad+'px',width:w+'px',height:d+'px'});
    b.innerHTML='<i class="top" style="transform:translateZ('+H+'px)"></i><i class="n" style="height:'+H+'px"></i><i class="s" style="top:'+d+'px;height:'+H+'px"></i><i class="w" style="width:'+H+'px"></i><i class="e" style="left:'+w+'px;width:'+H+'px"></i>';
    b.onmouseenter=()=>show(t.f);b.onclick=()=>show(t.f);lot.appendChild(b)}}
let rx=56,rz=-38;const place=()=>{const st0=document.getElementById('stage');const k=Math.min(.85,st0.clientWidth/1350,st0.clientHeight/1000);world.style.transform='scale('+k+') rotateX('+rx+'deg) rotateZ('+rz+'deg)'};place();addEventListener('resize',place);
let drag=null;const st=document.getElementById('stage');
st.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,rx,rz};st.setPointerCapture(e.pointerId)});
st.addEventListener('pointermove',e=>{if(!drag)return;rz=drag.rz+(e.clientX-drag.x)*.3;rx=Math.max(20,Math.min(75,drag.rx-(e.clientY-drag.y)*.2));place()});
st.addEventListener('pointerup',()=>{drag=null});
const first=Object.keys(D.files).sort((a,b)=>weight(D.files[b])-weight(D.files[a]))[0];if(first)show(first);
</script></body></html>`;
}

// The map as a city at night: districts are groups, roads between them carry the imports from one to the other, and every
// file is a building whose rooftop light says what to watch: red for a risk on it, amber for a rule, teal for nothing.
export function viewHtmlCity(data) {
  const json = JSON.stringify(data).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.name)}: what to read before you change a file</title>
<style>
:root{--fg:#efe9ff;--muted:#a79fc2;--line:#2a2140;--red:#ff4d5e;--amber:#ffc24b;--teal:#36e2d0;--road:#141020;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{color:var(--fg);font:14px/1.5 var(--sans);display:grid;grid-template-rows:auto 1fr;overflow:hidden;
 background:linear-gradient(180deg,#120a2a 0%,#2a1250 18%,#6b2a63 30%,#ff7a59 36%,#1a1030 37%,#0b0816 100%)}
header{display:flex;flex-wrap:wrap;gap:6px 22px;align-items:baseline;padding:14px 18px;position:relative;z-index:3;background:linear-gradient(#0b0816ee,#0b081600)}
h1{font:600 16px var(--mono);margin:0}h1 span{color:var(--muted);font-weight:400}
.legend{display:flex;flex-wrap:wrap;gap:14px;font:12px var(--mono);color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}
main{display:grid;grid-template-columns:1fr 380px;min-height:0}
#stage{position:relative;overflow:hidden;perspective:2000px;cursor:grab}#stage:active{cursor:grabbing}
#world{position:absolute;left:50%;top:58%;width:1000px;height:1000px;margin:-500px 0 0 -500px;transform-style:preserve-3d;
 background:var(--road);box-shadow:0 0 120px 40px rgba(120,60,200,.25);
 background-image:repeating-linear-gradient(0deg,transparent 0 49px,rgba(120,90,200,.12) 49px 50px),repeating-linear-gradient(90deg,transparent 0 49px,rgba(120,90,200,.12) 49px 50px)}
.district{position:absolute;transform-style:preserve-3d;background:#1d1630;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(160,120,255,.18)}
.sign{position:absolute;left:6px;bottom:-26px;font:700 13px var(--mono);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;color:#d9c8ff;text-shadow:0 0 8px #b07cff,0 0 18px #7a3cff;transform:translateZ(2px)}
.sign small{font-weight:400;color:var(--muted);text-shadow:none;margin-left:6px;letter-spacing:0}
.road{position:absolute;height:6px;transform-origin:0 50%;border-radius:3px;transform-style:preserve-3d;
 background:linear-gradient(90deg,rgba(54,226,208,.15),rgba(54,226,208,.9),rgba(54,226,208,.15));box-shadow:0 0 12px 2px rgba(54,226,208,.6);overflow:hidden}
.road::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 14px,rgba(255,255,255,.95) 14px 20px);animation:flow 1.6s linear infinite}
@keyframes flow{to{background-position:40px 0}}
@media (prefers-reduced-motion:reduce){.road::after{animation:none}}
.b{position:absolute;transform-style:preserve-3d;cursor:pointer}.b>i{position:absolute;display:block}
.b .top{inset:0}
.b .s,.b .n{left:0;width:100%;transform-origin:top;transform:rotateX(90deg)}.b .n{top:0}
.b .e,.b .w{top:0;height:100%;transform-origin:left;transform:rotateY(-90deg)}.b .w{left:0}
.b .s,.b .n,.b .e,.b .w{background-color:#231a3a;background-image:repeating-linear-gradient(0deg,transparent 0 5px,var(--win) 5px 7px,transparent 7px 9px),repeating-linear-gradient(90deg,#231a3a 0 3px,transparent 3px 6px)}
.b .e,.b .w{filter:brightness(.7)}
.b.red{--win:rgba(255,120,130,.55)}.b.amber{--win:rgba(255,205,110,.5)}.b.teal{--win:rgba(120,240,230,.35)}
.b.red .top{background:#ff5f6e;box-shadow:0 0 16px 4px rgba(255,77,94,.85),0 0 60px 14px rgba(255,77,94,.35)}
.b.amber .top{background:#ffcf6a;box-shadow:0 0 12px 3px rgba(255,194,75,.7),0 0 40px 8px rgba(255,194,75,.25)}
.b.teal .top{background:#2b2148;box-shadow:inset 0 0 0 1px rgba(54,226,208,.6),0 0 6px rgba(54,226,208,.35)}
.b.on .top{background:#fff!important}
aside{border-left:1px solid var(--line);background:#0e0a1bf2;padding:16px 18px;overflow:auto;position:relative;z-index:3}
aside h2{font:600 13px var(--mono);margin:0 0 4px;word-break:break-all}aside .sub{color:var(--muted);font:12px var(--mono);margin-bottom:12px}
aside h3{font:600 12px var(--mono);margin:16px 0 6px;color:#b9a3ff}aside ul{margin:0;padding-left:16px}aside li{margin:3px 0}
.r{color:var(--amber);font-family:var(--mono)}.k{color:var(--teal);font-family:var(--mono)}.w{color:#ff8a95}.hint{color:var(--muted)}
.tip{position:absolute;left:16px;bottom:12px;font:12px var(--mono);color:var(--muted);z-index:3}
@media (max-width:820px){body{overflow:auto}main{grid-template-columns:1fr}#stage{height:72vh}aside{border-left:0;border-top:1px solid var(--line)}}
</style></head><body>
<header><h1>${esc(data.name)} <span>· what to read before you change a file</span></h1>
<div class="legend"><span><i style="background:var(--red);box-shadow:0 0 8px var(--red)"></i>risk on this file</span><span><i style="background:var(--amber);box-shadow:0 0 8px var(--amber)"></i>a rule covers it</span><span><i style="background:var(--teal)"></i>clear</span><span><i style="background:var(--teal);border-radius:2px;width:18px;height:4px;box-shadow:0 0 6px var(--teal)"></i>imports between districts</span></div></header>
<main><div id="stage"><div id="world"></div><div class="tip">drag to turn · point at a building</div></div><aside id="side"></aside></main>
<script>
const D=${json};
function squarify(items,x,y,w,h){const out=[];let rest=items.slice();
  while(rest.length){const total=rest.reduce((s,i)=>s+i.v,0);const short=Math.min(w,h);let row=[],best=Infinity;
    for(const it of rest){const r=[...row,it];const s=r.reduce((a,b)=>a+b.v,0);const side=s/total*(w>=h?w:h);
      const worst=Math.max(...r.map(q=>{const len=q.v/s*short;return Math.max(side/len,len/side)}));if(worst>best)break;best=worst;row=r}
    const s=row.reduce((a,b)=>a+b.v,0);const frac=s/total;
    if(w>=h){const rw=w*frac;let yy=y;for(const it of row){const hh=h*it.v/s;out.push({...it,x,y:yy,w:rw,h:hh});yy+=hh}x+=rw;w-=rw}
    else{const rh=h*frac;let xx=x;for(const it of row){const ww=w*it.v/s;out.push({...it,x:xx,y,w:ww,h:rh});xx+=ww}y+=rh;h-=rh}
    rest=rest.slice(row.length)}return out}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const light=r=>r.own?'red':r.rules.length?'amber':'teal';
const weight=r=>r.rules.length*2+r.own*3+r.risks.length;
const world=document.getElementById('world'),side=document.getElementById('side');
function show(f){const r=D.files[f];const g=D.groups.find(x=>x.id===r.g);
  document.querySelectorAll('.b.on').forEach(t=>t.classList.remove('on'));const t=document.querySelector('[data-f="'+CSS.escape(f)+'"]');if(t)t.classList.add('on');
  let h='<h2>'+esc(f)+'</h2><div class="sub">district '+esc(g.id)+' · '+esc(g.title)+(r.users?' · used by '+r.users+' file'+(r.users>1?'s':''):'')+'</div>';
  if(r.risks.length)h+='<h3>## Watch out</h3><ul>'+r.risks.map(x=>'<li class="w">'+esc(x)+'</li>').join('')+'</ul>';
  if(r.rules.length)h+='<h3>## Rules that must keep holding</h3><ul>'+r.rules.map(x=>'<li><span class="r">'+esc(x[0])+'</span>: '+esc(x[1])+(x[2]?' <span class="hint">— why: '+esc(x[2])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.checks.length)h+='<h3>## Run these checks</h3><ul>'+r.checks.map(x=>'<li><span class="k">'+esc(x[0])+'</span>'+(x[1]?' <span class="hint">— '+esc(x[1])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.tests.length)h+='<h3>## Tests that reach this code</h3><ul>'+r.tests.map(x=>'<li class="k">'+esc(x)+'</li>').join('')+'</ul>';
  if(!r.risks.length&&!r.rules.length&&!r.checks.length&&!r.tests.length)h+='<p class="hint">Nothing in the map is tied to this file yet.</p>';
  side.innerHTML=h}
const S=1000,ROAD=56;
const gs=D.groups.map(g=>{const heat=g.files.reduce((s,f)=>s+weight(D.files[f]),0);return {...g,v:Math.sqrt(g.files.length)*(1+heat/Math.max(1,g.files.length))}}).sort((a,b)=>b.v-a.v);
const maxH=Math.max(1,...Object.values(D.files).map(r=>r.users+weight(r)*2));
const centers={};
for(const g of squarify(gs,ROAD/2,ROAD/2,S-ROAD,S-ROAD)){const d=document.createElement('div');d.className='district';
  const x=g.x+ROAD/2,y=g.y+ROAD/2,w=g.w-ROAD,h=g.h-ROAD;centers[g.id]=[x+w/2,y+h/2];
  Object.assign(d.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
  d.innerHTML='<div class="sign">'+esc(g.id)+'<small>'+g.files.length+' files</small></div>';world.appendChild(d);
  const fs=g.files.map(f=>{const r=D.files[f];return {f,r,v:1+Math.sqrt(r.users)+weight(r)}}).sort((a,b)=>b.v-a.v);
  for(const t of squarify(fs,6,6,w-12,h-12)){const pad=Math.max(2,Math.min(t.w,t.h)*.14);const bw=t.w-pad*2,bd=t.h-pad*2;if(bw<1||bd<1)continue;
    const H=Math.round(10+190*Math.sqrt((t.r.users+weight(t.r)*2)/maxH));
    const b=document.createElement('div');b.className='b '+light(t.r);b.dataset.f=t.f;b.title=t.f;
    Object.assign(b.style,{left:t.x+pad+'px',top:t.y+pad+'px',width:bw+'px',height:bd+'px'});
    b.innerHTML='<i class="top" style="transform:translateZ('+H+'px)"></i><i class="n" style="height:'+H+'px"></i><i class="s" style="top:'+bd+'px;height:'+H+'px"></i><i class="w" style="width:'+H+'px"></i><i class="e" style="left:'+bw+'px;width:'+H+'px"></i>';
    b.onmouseenter=()=>show(t.f);b.onclick=()=>show(t.f);d.appendChild(b)}}
const maxN=Math.max(1,...D.links.map(l=>l.n));
for(const l of D.links){const a=centers[l.a],b=centers[l.b];if(!a||!b)continue;const dx=b[0]-a[0],dy=b[1]-a[1];
  const r=document.createElement('div');r.className='road';r.title=l.a+' ↔ '+l.b+': '+l.n+' import'+(l.n>1?'s':'');
  Object.assign(r.style,{left:a[0]+'px',top:a[1]+'px',width:Math.hypot(dx,dy)+'px',height:(3+7*l.n/maxN)+'px',transform:'translateZ(3px) rotate('+Math.atan2(dy,dx)+'rad)'});world.appendChild(r)}
let rx=58,rz=-34;const st=document.getElementById('stage');
const place=()=>{const k=Math.min(.8,st.clientWidth/1450,st.clientHeight/1050);world.style.transform='scale('+k+') rotateX('+rx+'deg) rotateZ('+rz+'deg)'};place();addEventListener('resize',place);
let drag=null;st.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,rx,rz};st.setPointerCapture(e.pointerId)});
st.addEventListener('pointermove',e=>{if(!drag)return;rz=drag.rz+(e.clientX-drag.x)*.3;rx=Math.max(25,Math.min(72,drag.rx-(e.clientY-drag.y)*.2));place()});
st.addEventListener('pointerup',()=>{drag=null});
const first=Object.keys(D.files).sort((a,b)=>weight(D.files[b])-weight(D.files[a]))[0];if(first)show(first);
</script></body></html>`;
}
