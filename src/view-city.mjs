// The map as a city at night. Districts are groups (and, inside one, its folders); every file is a building whose rooftop
// says what to watch: a red crown for a risk on that file, amber for a rule, nothing for a file the map is quiet about.
// Skyways between districts carry the imports from one to the other. Click a district to go into it.
// One self-contained page: no network, no dependencies.
const esc = (s) => String(s).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function cityData(data, imports, labels = {}) {
  const inMap = new Set(Object.keys(data.files));
  const edges = imports.filter((e) => inMap.has(e.from) && inMap.has(e.to)).map((e) => [e.from, e.to]);
  return { ...data, edges, labels };
}

export function viewHtmlCity(data) {
  const json = JSON.stringify(data).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${esc(data.name)}: what to read before you change a file</title>
<style>
:root{--fg:#eef0f6;--muted:#9aa0b4;--line:#262a36;--red:#ff4757;--amber:#ffbe3d;--sky:#7ad7ff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{color:var(--fg);font:14px/1.5 var(--sans);display:grid;grid-template-rows:auto 1fr;overflow:hidden;
 background:linear-gradient(180deg,#0b0d1c 0%,#1b1838 22%,#3b2350 31%,#a34a54 35.5%,#f08a4b 36.5%,#141722 37%,#07080d 100%)}
header{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:center;padding:12px 16px;position:relative;z-index:5;background:linear-gradient(#07080df0,#07080d00)}
h1{font:600 15px var(--mono);margin:0}h1 span{color:var(--muted);font-weight:400}
.crumbs{font:12px var(--mono);color:var(--muted)}.crumbs a{color:var(--sky);cursor:pointer;text-decoration:none}.crumbs a:hover{text-decoration:underline}
.legend{display:flex;flex-wrap:wrap;gap:12px;font:12px var(--mono);color:var(--muted);margin-left:auto}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
main{display:grid;grid-template-columns:1fr 370px;min-height:0}
#stage{position:relative;overflow:hidden;perspective:2200px;cursor:grab;touch-action:none;user-select:none}#stage.drag{cursor:grabbing}
#world{position:absolute;left:50%;top:56%;width:1000px;height:1000px;margin:-500px 0 0 -500px;transform-style:preserve-3d;
 background-color:#0c0e14;background-image:
  repeating-linear-gradient(90deg,transparent 0 23px,rgba(255,220,140,.10) 23px 25px,transparent 25px 48px),
  repeating-linear-gradient(0deg,transparent 0 23px,rgba(255,220,140,.10) 23px 25px,transparent 25px 48px);
 box-shadow:0 0 160px 30px rgba(240,138,75,.12)}
.plot{position:absolute;transform-style:preserve-3d;background:#161922;border:3px solid #2a2e3a;border-radius:4px;cursor:pointer;transition:border-color .15s}
.plot:hover{border-color:#5a6274}
.plot .sign{position:absolute;left:4px;top:100%;margin-top:6px;transform:translateZ(1px);white-space:nowrap;pointer-events:none}
.plot .sign b{font:700 14px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:#fff;text-shadow:0 0 6px var(--sky),0 0 16px rgba(122,215,255,.6)}
.plot .sign small{display:block;font:11px var(--mono);color:#c9cfdc;text-shadow:0 1px 2px #000}
.plot .sign .warn{color:var(--red)}.plot .sign .rule{color:var(--amber)}
.b{position:absolute;transform-style:preserve-3d;cursor:pointer}.b>i{position:absolute;display:block}
.b .roof{inset:0;background:#20242e;border:1px solid #3a4050}
.b .n,.b .s{left:0;width:100%;transform-origin:top;transform:rotateX(90deg)}.b .n{top:0}
.b .e,.b .w{top:0;height:100%;transform-origin:left;transform:rotateY(-90deg)}.b .w{left:0}
.b .n,.b .s,.b .e,.b .w{background-color:var(--wall);
 background-image:repeating-linear-gradient(90deg,var(--mull) 0 2px,transparent 2px 7px),
  repeating-linear-gradient(0deg,transparent 0 4px,var(--lit) 4px 7px,transparent 7px 9px),
  repeating-linear-gradient(90deg,transparent 0 13px,rgba(0,0,0,.55) 13px 20px,transparent 20px 31px)}
.b .e,.b .w{filter:brightness(.62)}
.b.glass{--wall:#1c2735;--mull:#0e141c;--lit:rgba(150,205,255,.42)}
.b.stone{--wall:#2b2a2f;--mull:#17161a;--lit:rgba(255,210,140,.48)}
.b.brick{--wall:#33262a;--mull:#1a1215;--lit:rgba(255,190,120,.42)}
.b.red .roof{border:2px solid var(--red);box-shadow:0 0 14px 3px rgba(255,71,87,.9),inset 0 0 12px rgba(255,71,87,.6)}
.b.red .roof::after{content:"";position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:#fff;box-shadow:0 0 10px 4px var(--red),0 0 40px 10px rgba(255,71,87,.5)}
.b.red{--lit:rgba(255,120,130,.55)}
.b.amber .roof{border:2px solid var(--amber);box-shadow:0 0 10px 2px rgba(255,190,61,.75),inset 0 0 10px rgba(255,190,61,.45)}
.b.on .roof{background:#fff}
.glowfloor{position:absolute;border-radius:50%;pointer-events:none;transform:translateZ(.5px)}
.sky{position:absolute;height:5px;transform-origin:0 50%;border-radius:3px;pointer-events:none;
 background:linear-gradient(90deg,rgba(122,215,255,.1),rgba(122,215,255,.95) 50%,rgba(122,215,255,.1));box-shadow:0 0 14px 3px rgba(122,215,255,.55);overflow:hidden}
.sky::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 16px,#fff 16px 22px);animation:flow 1.4s linear infinite}
@keyframes flow{to{background-position:44px 0}}
@media (prefers-reduced-motion:reduce){.sky::after{animation:none}}
.ctl{position:absolute;right:12px;bottom:12px;display:flex;gap:6px;z-index:4}
.ctl button{width:38px;height:38px;border-radius:8px;border:1px solid #39405a;background:#121624e6;color:#dfe5f5;font:16px var(--mono);cursor:pointer}
.ctl button:hover{border-color:var(--sky)}
.tip{position:absolute;left:14px;top:10px;font:12px var(--mono);color:var(--muted);z-index:4;pointer-events:none}
aside{border-left:1px solid var(--line);background:#0a0c14f2;padding:16px 18px;overflow:auto;position:relative;z-index:5}
aside h2{font:600 13px var(--mono);margin:0 0 4px;word-break:break-all}aside .sub{color:var(--muted);font:12px var(--mono);margin-bottom:12px}
aside .label{background:#151a28;border:1px solid #29304a;border-radius:6px;padding:8px 10px;margin:8px 0 4px;color:#d9e2ff}
aside h3{font:600 12px var(--mono);margin:16px 0 6px;color:var(--sky)}aside ul{margin:0;padding-left:16px}aside li{margin:3px 0}
.r{color:var(--amber);font-family:var(--mono)}.k{color:#8be9c9;font-family:var(--mono)}.w{color:#ff8994}.hint{color:var(--muted)}
@media (max-width:820px){body{overflow:auto}main{grid-template-columns:1fr}#stage{height:74vh}aside{border-left:0;border-top:1px solid var(--line)}.legend{margin-left:0}}
</style></head><body>
<header><h1>${esc(data.name)} <span>· what to read before you change a file</span></h1><div class="crumbs" id="crumbs"></div>
<div class="legend"><span><i style="background:var(--red);box-shadow:0 0 8px var(--red)"></i>risk on this file</span><span><i style="background:var(--amber);box-shadow:0 0 8px var(--amber)"></i>a rule covers it</span><span><i style="background:var(--sky);border-radius:2px;width:18px;height:4px;box-shadow:0 0 6px var(--sky)"></i>imports between districts</span></div></header>
<main><div id="stage"><div id="world"></div>
<div class="ctl"><button id="rl" title="turn left">⟲</button><button id="rr" title="turn right">⟳</button><button id="zo" title="zoom out">−</button><button id="zi" title="zoom in">+</button><button id="home" title="back to the start">⌂</button></div>
<div class="tip">drag to turn · wheel or pinch to zoom · click a district to go in</div></div><aside id="side"></aside></main>
<script>
const D=${json};
const L=D.labels||{};
function squarify(items,x,y,w,h){const out=[];let rest=items.filter(i=>i.v>0);
  while(rest.length){const total=rest.reduce((s,i)=>s+i.v,0);const short=Math.min(w,h);let row=[],best=Infinity;
    for(const it of rest){const r=[...row,it];const s=r.reduce((a,b)=>a+b.v,0);const side=s/total*(w>=h?w:h);
      const worst=Math.max(...r.map(q=>{const len=q.v/s*short;return Math.max(side/len,len/side)}));if(worst>best)break;best=worst;row=r}
    const s=row.reduce((a,b)=>a+b.v,0);const frac=s/total;
    if(w>=h){const rw=w*frac;let yy=y;for(const it of row){const hh=h*it.v/s;out.push({...it,x,y:yy,w:rw,h:hh});yy+=hh}x+=rw;w-=rw}
    else{const rh=h*frac;let xx=x;for(const it of row){const ww=w*it.v/s;out.push({...it,x:xx,y,w:ww,h:rh});xx+=ww}y+=rh;h-=rh}
    rest=rest.slice(row.length)}return out}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const weight=r=>r.rules.length*2+r.own*3+r.risks.length;
const light=r=>r.own?'red':r.rules.length?'amber':'';
const hash=s=>{let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))|0;return Math.abs(h)};
const material=f=>['glass','stone','brick'][hash(f)%3];
const fileV=f=>{const r=D.files[f];return 1+Math.sqrt(r.users)+weight(r)};
const maxH=Math.max(1,...Object.values(D.files).map(r=>r.users+weight(r)*2));
const height=f=>{const r=D.files[f];return Math.round(10+200*Math.sqrt((r.users+weight(r)*2)/maxH))};

// A level is a list of districts (each with its files) and loose buildings. The top is the map's groups; inside a group or
// a folder, its sub-folders become districts and the files directly in it stand on their own.
function levelOf(path){
  if(!path.length)return {districts:D.groups.map(g=>({key:'g:'+g.id,name:g.id,label:L[g.id]||g.title,files:g.files,into:[{g:g.id,prefix:commonDir(g.files),name:g.id}]})),loose:[]};
  const at=path[path.length-1];const g=D.groups.find(x=>x.id===at.g);let prefix=at.prefix;let files=g.files.filter(f=>f.startsWith(prefix));
  // A folder with one sub-folder and no files of its own is skipped, so every level shows a choice.
  for(;;){const rels=files.map(f=>f.slice(prefix.length));const subs=new Set(rels.filter(r=>r.includes('/')).map(r=>r.split('/')[0]));
    if(subs.size===1&&rels.every(r=>r.includes('/'))){prefix+=[...subs][0]+'/';continue}break}
  const bySub=new Map(),loose=[];
  for(const f of files){const rel=f.slice(prefix.length);if(rel.includes('/')){const s=rel.split('/')[0];bySub.set(s,[...(bySub.get(s)??[]),f])}else loose.push(f)}
  return {districts:[...bySub].map(([s,fs])=>({key:'d:'+prefix+s,name:s,label:L[prefix+s]||'',files:fs,into:[...path,{g:at.g,prefix:prefix+s+'/',name:s}]})),loose};
}
function commonDir(files){if(!files.length)return '';let p=files[0].split('/').slice(0,-1);for(const f of files){const q=f.split('/').slice(0,-1);let i=0;while(i<p.length&&p[i]===q[i])i++;p=p.slice(0,i)}return p.length?p.join('/')+'/':''}

const world=document.getElementById('world'),side=document.getElementById('side'),crumbs=document.getElementById('crumbs'),stage=document.getElementById('stage');
let path=[];
function stats(files){let red=0,amber=0;for(const f of files){const r=D.files[f];if(r.own)red++;else if(r.rules.length)amber++}return {red,amber}}
function building(parent,f,x,y,w,d,scale=1){const r=D.files[f];const pad=Math.max(1.5,Math.min(w,d)*.13);const bw=w-pad*2,bd=d-pad*2;if(bw<1||bd<1)return;
  const H=Math.round(height(f)*scale);const b=document.createElement('div');b.className='b '+material(f)+' '+light(r);b.dataset.f=f;b.title=f;
  Object.assign(b.style,{left:x+pad+'px',top:y+pad+'px',width:bw+'px',height:bd+'px'});
  b.innerHTML='<i class="roof" style="transform:translateZ('+H+'px)"></i><i class="n" style="height:'+H+'px"></i><i class="s" style="top:'+bd+'px;height:'+H+'px"></i><i class="w" style="width:'+H+'px"></i><i class="e" style="left:'+bw+'px;width:'+H+'px"></i>';
  if(r.own){const g=document.createElement('div');g.className='glowfloor';const s=Math.max(bw,bd)*2.4;Object.assign(g.style,{left:x+w/2-s/2+'px',top:y+d/2-s/2+'px',width:s+'px',height:s+'px',background:'radial-gradient(circle,rgba(255,71,87,.35),transparent 65%)'});parent.appendChild(g)}
  b.onmouseenter=()=>showFile(f);b.onclick=e=>{e.stopPropagation();showFile(f,true)};parent.appendChild(b)}
function draw(){world.innerHTML='';const lv=levelOf(path);const S=1000,ROAD=path.length?44:56;
  const items=[...lv.districts.map(d=>({...d,v:Math.sqrt(d.files.length)*(1+d.files.reduce((s,f)=>s+weight(D.files[f]),0)/d.files.length)})),...lv.loose.map(f=>({loose:f,v:fileV(f)*(path.length?1.6:1)}))].sort((a,b)=>b.v-a.v);
  const centers={};
  for(const it of squarify(items,ROAD/2,ROAD/2,S-ROAD,S-ROAD)){
    if(it.loose){building(world,it.loose,it.x+ROAD/4,it.y+ROAD/4,it.w-ROAD/2,it.h-ROAD/2,1.25);centers['f:'+it.loose]=[it.x+it.w/2,it.y+it.h/2];continue}
    const x=it.x+ROAD/2,y=it.y+ROAD/2,w=it.w-ROAD,h=it.h-ROAD;if(w<4||h<4)continue;centers[it.key]=[x+w/2,y+h/2,it.files];
    const p=document.createElement('div');p.className='plot';Object.assign(p.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
    const st=stats(it.files);
    p.innerHTML='<div class="sign"><b>'+esc(it.name)+'</b><small>'+it.files.length+' files'+(st.red?' · <span class="warn">'+st.red+' risk</span>':'')+(st.amber?' · <span class="rule">'+st.amber+' rule</span>':'')+'</small></div>';
    p.onmouseenter=()=>showDistrict(it);p.onclick=()=>{path=it.into;draw();home()};world.appendChild(p);
    const fs=it.files.map(f=>({f,v:fileV(f)}));for(const t of squarify(fs,4,4,w-14,h-14))building(p,t.f,t.x,t.y,t.w,t.h,.85)}
  // Skyways: imports between the districts (or loose buildings) of this level, above the rooftops.
  const owner={};for(const [k,c] of Object.entries(centers)){if(k.startsWith('f:'))owner[k.slice(2)]=k;else for(const f of c[2])owner[f]=k}
  const links=new Map();for(const [a,b] of D.edges){const A=owner[a],B=owner[b];if(!A||!B||A===B)continue;const k=[A,B].sort().join('|');links.set(k,(links.get(k)??0)+1)}
  const maxN=Math.max(1,...links.values());const Z=Math.round(Math.max(...Object.keys(centers).filter(k=>k.startsWith('f:')).map(k=>height(k.slice(2))*1.25),...Object.values(centers).filter(c=>c[2]).flatMap(c=>c[2].map(f=>height(f)*.85)),40)+26);
  // At most the twelve busiest skyways, so a level with many small links stays readable.
  for(const [k,n] of [...links].sort((a,b)=>b[1]-a[1]).slice(0,12)){const [A,B]=k.split('|');const a=centers[A],b=centers[B];const dx=b[0]-a[0],dy=b[1]-a[1];
    const s=document.createElement('div');s.className='sky';s.title=n+' import'+(n>1?'s':'');
    Object.assign(s.style,{left:a[0]+'px',top:a[1]+'px',width:Math.hypot(dx,dy)+'px',height:3+6*n/maxN+'px',transform:'translateZ('+Z+'px) rotate('+Math.atan2(dy,dx)+'rad)'});world.appendChild(s)}
  crumbs.innerHTML='<a data-i="0">city</a>'+path.map((p,i)=>' › <a data-i="'+(i+1)+'">'+esc(p.name)+'</a>').join('');
  crumbs.querySelectorAll('a').forEach(a=>a.onclick=()=>{path=path.slice(0,+a.dataset.i);draw();home()});
  const all=[...lv.districts.flatMap(d=>d.files),...lv.loose];const top=all.sort((a,b)=>weight(D.files[b])-weight(D.files[a]))[0];if(top)showFile(top)}
function showDistrict(d){const st=stats(d.files);
  side.innerHTML='<h2>'+esc(d.name)+'</h2><div class="sub">'+d.files.length+' files · '+st.red+' with a risk · '+st.amber+' under a rule · click to go in</div>'+(d.label?'<div class="label">'+esc(d.label)+'</div>':'')}
function showFile(f,pin){const r=D.files[f];const g=D.groups.find(x=>x.id===r.g);
  document.querySelectorAll('.b.on').forEach(t=>t.classList.remove('on'));const t=document.querySelector('[data-f="'+CSS.escape(f)+'"]');if(t)t.classList.add('on');
  let h='<h2>'+esc(f)+'</h2><div class="sub">district '+esc(g.id)+(r.users?' · used by '+r.users+' file'+(r.users>1?'s':''):'')+'</div>';
  if(L[f])h+='<div class="label">'+esc(L[f])+'</div>';
  if(r.risks.length)h+='<h3>## Watch out</h3><ul>'+r.risks.map(x=>'<li class="w">'+esc(x)+'</li>').join('')+'</ul>';
  if(r.rules.length)h+='<h3>## Rules that must keep holding</h3><ul>'+r.rules.map(x=>'<li><span class="r">'+esc(x[0])+'</span>: '+esc(x[1])+(x[2]?' <span class="hint">— why: '+esc(x[2])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.checks.length)h+='<h3>## Run these checks</h3><ul>'+r.checks.map(x=>'<li><span class="k">'+esc(x[0])+'</span>'+(x[1]?' <span class="hint">— '+esc(x[1])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.tests.length)h+='<h3>## Tests that reach this code</h3><ul>'+r.tests.map(x=>'<li class="k">'+esc(x)+'</li>').join('')+'</ul>';
  if(!r.risks.length&&!r.rules.length&&!r.checks.length&&!r.tests.length)h+='<p class="hint">Nothing in the map is tied to this file yet.</p>';
  side.innerHTML=h}
// Camera: turn by dragging, zoom with the wheel or two fingers, buttons for both.
let rx=56,rz=-34,zoom=1;const fit=()=>Math.min(.82,stage.clientWidth/1400,stage.clientHeight/1050);
const place=()=>{world.style.transform='scale('+(fit()*zoom)+') rotateX('+rx+'deg) rotateZ('+rz+'deg)'};
const home=()=>{rx=56;rz=-34;zoom=1;place()};
const pts=new Map();let start=null;
stage.addEventListener('pointerdown',e=>{if(e.target.closest('.ctl'))return;pts.set(e.pointerId,[e.clientX,e.clientY]);stage.setPointerCapture(e.pointerId);
  start={rx,rz,zoom,pts:new Map(pts)};stage.classList.add('drag')});
stage.addEventListener('pointermove',e=>{if(!pts.has(e.pointerId)||!start)return;pts.set(e.pointerId,[e.clientX,e.clientY]);
  if(pts.size===1&&start.pts.size===1){const [x0,y0]=[...start.pts.values()][0];rz=start.rz+(e.clientX-x0)*.3;rx=Math.max(20,Math.min(78,start.rx-(e.clientY-y0)*.2))}
  else if(pts.size>=2&&start.pts.size>=2){const d=m=>{const [a,b]=[...m.values()];return Math.hypot(a[0]-b[0],a[1]-b[1])};zoom=Math.max(.5,Math.min(4,start.zoom*d(pts)/d(start.pts)))}
  place()});
const end=e=>{pts.delete(e.pointerId);start=pts.size?{rx,rz,zoom,pts:new Map(pts)}:null;if(!pts.size)stage.classList.remove('drag')};
stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end);
stage.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.5,Math.min(4,zoom*Math.exp(-e.deltaY*.0015)));place()},{passive:false});
document.getElementById('rl').onclick=()=>{rz-=30;place()};document.getElementById('rr').onclick=()=>{rz+=30;place()};
document.getElementById('zi').onclick=()=>{zoom=Math.min(4,zoom*1.25);place()};document.getElementById('zo').onclick=()=>{zoom=Math.max(.5,zoom/1.25);place()};
document.getElementById('home').onclick=()=>{path=[];draw();home()};
addEventListener('keydown',e=>{if(e.key==='Escape'&&path.length){path=path.slice(0,-1);draw();home()}});
addEventListener('resize',place);draw();place();
</script></body></html>`;
}
