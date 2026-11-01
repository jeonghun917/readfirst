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
  return {
    name,
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
