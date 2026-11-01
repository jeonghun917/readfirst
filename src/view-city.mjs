// The map as a night city in WebGL. Groups are neighbourhoods of real city blocks on a street grid; every file is a
// building on a lot, taller when more depends on it. Lit windows everywhere; a red-lit building has a risk on it, an
// amber one is under a rule. Traffic on the streets between two neighbourhoods carries the imports between them.
// The page loads three.js from a CDN (pinned); the data is inlined.
const esc = (s) => String(s).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.160.0';

// The page data: viewData plus the import edges between mapped files and the local labels (see labels.mjs).
export function cityData(data, imports, labels = {}) {
  const inMap = new Set(Object.keys(data.files));
  const edges = imports.filter((e) => inMap.has(e.from) && inMap.has(e.to)).map((e) => [e.from, e.to]);
  return { ...data, edges, labels };
}

export function viewHtmlCity(data) {
  const json = JSON.stringify(data).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${esc(data.name)}: what to read before you change a file</title>
<style>
:root{--fg:#eef0f6;--muted:#9aa0b4;--red:#ff4757;--amber:#ffbe3d;--sky:#7ad7ff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-text-size-adjust:100%;overscroll-behavior:none;background:#05060a;color:var(--fg);font:14px/1.5 var(--sans)}
canvas{display:block;touch-action:none}
#top{position:absolute;left:0;right:0;top:0;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;padding:12px 16px;background:linear-gradient(#05060ae6,#05060a00);pointer-events:none;z-index:3}
#top>*{pointer-events:auto}h1{font:600 15px var(--mono);margin:0}h1 span{color:var(--muted);font-weight:400}
.legend{display:flex;flex-wrap:wrap;gap:12px;font:12px var(--mono);color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
#labels{position:absolute;inset:0;pointer-events:none;z-index:2}
.hood{position:absolute;transform:translate(-50%,-100%);font:700 14px var(--sans);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;color:#fff;text-shadow:0 0 8px hsl(var(--h) 90% 60%),0 0 20px hsl(var(--h) 90% 55%),0 1px 2px #000;pointer-events:auto;cursor:pointer;padding:3px 9px;border-left:3px solid hsl(var(--h) 90% 60%);background:#05060a99;border-radius:2px}
.hood small{display:block;text-align:center;font:500 10px var(--mono);letter-spacing:0;text-transform:none;color:#d6dbe8;text-shadow:0 1px 2px #000}
.hood small .w{color:#ff8994}.hood small .r{color:var(--amber)}
.street{position:absolute;transform:translate(-50%,-100%);font:600 11px var(--mono);color:#e9eefb;background:#0b0e18cc;border:1px solid #2c3550;border-radius:4px;padding:1px 6px;white-space:nowrap;pointer-events:auto;cursor:pointer}
.panel{position:absolute;right:14px;top:58px;bottom:14px;width:360px;background:#0a0c14eb;border:1px solid #232a3d;border-radius:12px;z-index:3;backdrop-filter:blur(6px);display:none;flex-direction:column}
.panel.shown{display:flex}
#ph{display:flex;align-items:center;gap:8px;padding:12px 12px 8px 18px}#pt{flex:1;font:600 13px var(--mono);word-break:break-all;-webkit-user-select:text;user-select:text}
#ph button{flex:none;width:32px;height:32px;border-radius:8px;border:1px solid #39405a;background:#121624;color:#dfe5f5;font:15px var(--mono);cursor:pointer}#pm{display:none}
#pb{padding:0 18px 16px;overflow:auto;touch-action:pan-y;-webkit-user-select:text;user-select:text}
#mode{margin-left:auto}#mode+#lang{margin-left:0}#lang,#mode{font:600 12px var(--mono);border:1px solid #39405a;background:#121624e6;color:#dfe5f5;border-radius:8px;padding:5px 10px;cursor:pointer}
.panel .sub{color:var(--muted);font:12px var(--mono);margin-bottom:10px}
.panel .on{margin-top:2px;font:11px var(--mono);color:var(--muted)}.panel a.fl{color:#9fdcff;text-decoration:underline dotted;cursor:pointer;margin-right:6px}.panel .label small.mine{display:block;font:11px var(--mono);color:var(--muted);margin-bottom:3px}.panel .label{background:#151a28;border:1px solid #29304a;border-radius:6px;padding:8px 10px;margin:8px 0 4px;color:#d9e2ff}
.panel h3{font:600 12px var(--mono);margin:14px 0 6px;color:var(--sky)}.panel ul{margin:0;padding-left:16px}.panel li{margin:3px 0}
.k{color:#8be9c9;font-family:var(--mono)}.rr{color:var(--amber);font-family:var(--mono)}.w{color:#ff8994}.hint{color:var(--muted)}
.ctl{position:absolute;left:14px;bottom:14px;display:flex;gap:6px;z-index:3}
.ctl button{width:40px;height:40px;border-radius:10px;border:1px solid #39405a;background:#121624e6;color:#dfe5f5;font:16px var(--mono);cursor:pointer}
.ctl button:hover{border-color:var(--sky)}
.tip{position:absolute;left:14px;bottom:62px;font:12px var(--mono);color:var(--muted);z-index:3;pointer-events:none}
#err{position:fixed;inset:0;display:none;place-items:center;text-align:center;color:var(--muted);font:13px var(--mono)}
html.m .panel{left:8px;right:8px;top:auto;bottom:8px;width:auto;max-height:52px;overflow:hidden;transition:max-height .25s ease}
html.m .panel.open{max-height:55%}html.m #ph{padding:10px 10px 10px 14px;cursor:pointer}html.m #pt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;word-break:normal}html.m #pm{display:block}html.m .panel.open #pm{transform:rotate(180deg)}
html.m #pb{padding:0 14px 14px}html.m .ctl{left:auto;right:8px;bottom:auto;top:84px;flex-direction:column}html.m .ctl button{width:42px;height:42px}html.m .tip{display:none}
html.m #top{padding:10px 12px;gap:4px 10px}html.m .legend{font-size:11px;gap:4px 10px;order:3;width:100%}html.m .legend span:nth-child(3){display:none}html.m h1 span{display:none}
#ui{position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:3;transform-origin:0 0}#ui .panel,#ui .ctl{pointer-events:auto}
</style>
<script type="importmap">{"imports":{"three":"${THREE}/build/three.module.js","three/addons/":"${THREE}/examples/jsm/"}}</script>
</head><body>
<div id="ui"><div id="top"><h1>${esc(data.name)} <span data-t="sub"></span></h1>
<div class="legend"><span><i style="background:var(--red);box-shadow:0 0 8px var(--red)"></i><b data-t="lRisk" style="font-weight:400"></b></span><span><i style="background:var(--amber);box-shadow:0 0 8px var(--amber)"></i><b data-t="lRule" style="font-weight:400"></b></span><span><i style="background:#fff;box-shadow:0 0 6px #fff"></i><b data-t="lCar" style="font-weight:400"></b></span></div><button id="mode" hidden></button><button id="lang"></button></div>
<div id="labels"></div><aside class="panel" id="side"><div id="ph"><div id="pt"></div><button id="pm">▴</button><button id="px">×</button></div><div id="pb"></div></aside>
<div class="tip" data-t="tip"></div>
<div class="ctl"><button id="rl">⟲</button><button id="rr">⟳</button><button id="zo">−</button><button id="zi">+</button><button id="home">⌂</button></div></div>
<div id="err" data-t="err"></div>
<script>
// Some phones open a local file at desktop width (about 980px) and ignore the viewport tag; then everything on top of
// the city would be tiny. Scale the controls layer back up to the phone's real size, and use the phone layout.
function fitUi(){const ui=document.getElementById('ui');const coarse=matchMedia('(pointer:coarse)').matches;
  const k=coarse&&innerWidth>screen.width*1.15?innerWidth/screen.width:1;window.__ui=k;
  ui.style.transform=k===1?'':'scale('+k+')';ui.style.width=innerWidth/k+'px';ui.style.height=innerHeight/k+'px';
  document.documentElement.classList.toggle('m',innerWidth/k<=820)}
fitUi();addEventListener('resize',fitUi);
// Keep the browser's own zoom off this page: pinch, double tap, ctrl+wheel and ctrl +/- zoom the city instead.
for(const t of ['gesturestart','gesturechange','gestureend'])document.addEventListener(t,e=>e.preventDefault(),{passive:false});
document.addEventListener('touchmove',e=>{if(e.touches.length>1)e.preventDefault()},{passive:false});
let lastTap=0;document.addEventListener('touchend',e=>{const n=Date.now();if(n-lastTap<320&&e.target.tagName==='CANVAS')e.preventDefault();lastTap=n},{passive:false});
document.addEventListener('dblclick',e=>e.preventDefault(),{passive:false});
addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey)e.preventDefault()},{passive:false});
addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&['+','=','-','_','0'].includes(e.key))e.preventDefault()});
</script>
<script type="module">
import * as T from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
const D=${json};const LB=D.labels||{};const LL=()=>LB[lang]||{};
// Two modes, in any language: the map as written (technical terms kept; translated when a labels file has "text"), and
// plain notes ("plain"), which exist only for whoever wrote a labels file on their own machine.
let mode=(()=>{try{return localStorage.getItem('rf-mode')||'base'}catch{return 'base'}})();
const plainOn=()=>mode==='plain'&&!!LL().plain;const PL=()=>plainOn()?LL().plain:{};
const tr=x=>{const p=PL().text?.[x];if(p)return p;const d=LL().text?.[x];if(d)return d;const m=/^checks for (.+)$/s.exec(x);if(m){const r=tr(m[1]);if(r!==m[1])return t('checksFor')(r)}return x};
const gname=id=>PL().groups?.[id]?.name;
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const S={en:{sub:'· what to read before you change a file',lRisk:'risk on this building',lRule:'a rule covers it',lCar:'traffic = imports between neighbourhoods',
  tip:'drag to move · right-drag or two fingers to turn · wheel or pinch to zoom · click a neighbourhood to fly there',err:'This view needs WebGL and a connection to load three.js.',
  rl:'turn left',rr:'turn right',zo:'zoom out',zi:'zoom in',home:'whole city',pm:'details',px:'close',lang:'한국어',
  files:n=>n+' files',risk:n=>n+' risk',rule:n=>n+' rule',hood:'neighbourhood',bld:n=>n+' buildings',wRisk:n=>n+' with a risk',wRule:n=>n+' under a rule',
  hint:'Point at or tap a building to see what to read before changing that file.',usedBy:n=>'used by '+n+' file'+(n>1?'s':''),
  noLabels:'',checksFor:x=>'checks for '+x,modePlain:'Plain notes',modeBase:'Technical',mine:'plain note · only on this machine',hRisk:'Watch out',hRule:'Rules that must keep holding',hCheck:'Run these checks',hTest:'Tests that reach this code',why:'why',none:'Nothing in the map is tied to this file yet.'},
 ko:{sub:'· 파일을 고치기 전에 읽을 것',lRisk:'위험이 있는 건물',lRule:'규칙이 걸린 건물',lCar:'차량 = 구역 사이 코드 연결',
  tip:'끌어서 이동 · 우클릭이나 두 손가락으로 회전 · 휠이나 꼬집기로 확대 · 구역 이름을 누르면 그곳으로 이동',err:'이 화면은 WebGL과 three.js를 불러올 인터넷 연결이 필요해요.',
  rl:'왼쪽으로 돌기',rr:'오른쪽으로 돌기',zo:'축소',zi:'확대',home:'도시 전체',pm:'자세히',px:'닫기',lang:'English',
  files:n=>'파일 '+n+'개',risk:n=>'위험 '+n,rule:n=>'규칙 '+n,hood:'구역',bld:n=>'건물 '+n+'채',wRisk:n=>'위험 '+n,wRule:n=>'규칙 '+n,
  hint:'건물을 가리키거나 누르면 그 파일을 고치기 전에 읽을 것이 나와요.',usedBy:n=>n+'개 파일이 사용',
  checksFor:x=>x+' 확인',modePlain:'쉬운 설명',modeBase:'기본 설명',mine:'쉬운 설명 · 이 컴퓨터에만 있어요',noLabels:'지도 원문 그대로예요. 한국어로 보려면 에이전트에게 npx readfirst prompt --labels ko 를 주세요.',hRisk:'주의할 점',hRule:'지켜야 할 규칙',hCheck:'돌려야 할 검사',hTest:'이 코드에 닿는 테스트',why:'이유',none:'아직 지도에 이 파일과 이어진 내용이 없어요.'}};
let lang=(()=>{const q=new URLSearchParams(location.search).get('lang');if(q&&S[q])return q;try{const v=localStorage.getItem('rf-lang');if(v&&S[v])return v}catch{}return /^ko/i.test(navigator.language)?'ko':'en'})();
const t=k=>S[lang][k];
function applyLang(){document.documentElement.lang=lang;document.querySelectorAll('[data-t]').forEach(e=>e.textContent=t(e.dataset.t));
  for(const id of ['rl','rr','zo','zi','home','pm','px']){const e=document.getElementById(id);e.title=t(id);e.setAttribute('aria-label',t(id))}document.getElementById('lang').textContent=t('lang');const mb=document.getElementById('mode');if(mb){mb.hidden=!LB[lang]?.plain;mb.textContent=t(plainOn()?'modeBase':'modePlain')}}
applyLang();
const weight=r=>r.rules.length*2+r.own*3+r.risks.length;
const status=r=>r.own?1:r.rules.length?2:0;
const hash=s=>{let h=2166136261;for(const c of s){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return (h>>>0)/4294967295};

// ---- City plan: each group becomes blocks of up to 3x3 lots, folder by folder. The busiest group takes the middle
// (downtown); each group then grows outward as one piece from the free cell nearest the middle. A few gaps become parks,
// and a ring of unlit-by-data blocks around it all makes the skyline.
const LOT=12,K=3,B=K*LOT,ST=14,P=B+ST,PER=K*K;
const imp=g=>Math.sqrt(g.files.length)*(1+g.files.reduce((s,f)=>s+weight(D.files[f]),0)/g.files.length);
const groups=[...D.groups].sort((a,b)=>imp(b)-imp(a));
const blocks=[];
for(const g of groups){
  const byDir=new Map();for(const f of g.files){const d=f.includes('/')?f.slice(0,f.lastIndexOf('/')):'(top)';byDir.set(d,[...(byDir.get(d)??[]),f])}
  let cur=null;
  for(const [dir,fs] of [...byDir].sort((a,b)=>a[0].localeCompare(b[0]))){
    const sorted=fs.sort((a,b)=>(D.files[b].users+weight(D.files[b]))-(D.files[a].users+weight(D.files[a])));
    for(let i=0;i<sorted.length;i+=PER){const part=sorted.slice(i,i+PER);
      if(cur&&cur.files.length+part.length<=PER&&part.length<4){cur.files.push(...part);cur.dirs.push(dir);continue}
      cur={g:g.id,dirs:[dir],files:[...part]};blocks.push(cur)}}
}
const R=Math.ceil(Math.sqrt(blocks.length*2.4)/2)+2;const RING=8;const n=2*(R+RING)+1;
const taken=new Map();const key=(i,j)=>i+','+j;const d0=(i,j)=>Math.hypot(i,j*1.05);
const near=[];for(let i=-R;i<=R;i++)for(let j=-R;j<=R;j++)near.push([i,j]);near.sort((a,b)=>d0(...a)-d0(...b));
// a cell may not touch (even corner to corner) a cell of another neighbourhood: that keeps a boulevard between them
const clash=(c,g)=>{for(let di=-1;di<=1;di++)for(let dj=-1;dj<=1;dj++){const o=taken.get(key(c[0]+di,c[1]+dj));if(o&&o.g!==g)return true}return false};
let gi=0;for(const g of groups){const mine=blocks.filter(b=>b.g===g.id);const seed=near.find(c=>!taken.has(key(...c))&&!clash(c,g.id))??near.find(c=>!taken.has(key(...c)));const region=[];
  for(const b of mine){let best=null,bd=Infinity;const cand=region.length?region.flatMap(([i,j])=>[[i+1,j],[i-1,j],[i,j+1],[i,j-1]]):[seed];
    for(const c of cand){if(taken.has(key(...c))||clash(c,g.id)||Math.abs(c[0])>R||Math.abs(c[1])>R)continue;const d=Math.hypot(c[0]-seed[0],c[1]-seed[1])+d0(...c)*.35;if(d<bd){bd=d;best=c}}
    if(!best)best=near.find(c=>!taken.has(key(...c))&&!clash(c,g.id))??near.find(c=>!taken.has(key(...c)));taken.set(key(...best),b);region.push(best);b.cell=best}
  gi++}
const off=-(n*P)/2+ST/2;const cellXY=([i,j])=>[(i)*P-B/2,(j)*P-B/2];
blocks.forEach(b=>{[b.x,b.z]=cellXY(b.cell)});
const used=[...taken.keys()].map(k=>k.split(',').map(Number));const maxR=Math.max(...used.map(([i,j])=>Math.max(Math.abs(i),Math.abs(j))));
const parks=[],filler=[];
const maxD=Math.max(...used.map(([i,j])=>Math.hypot(i,j)));
for(let i=-(maxR+RING);i<=maxR+RING;i++)for(let j=-(maxR+RING);j<=maxR+RING;j++){if(taken.has(key(i,j)))continue;
  const d=Math.hypot(i,j);const h=hash(i+':'+j);
  if(d<=maxD-.5){if(h<.3)parks.push(cellXY([i,j]))}else if(h<.08)parks.push(cellXY([i,j]));else filler.push([...cellXY([i,j]),Math.max(1,Math.round(d-maxD+.5))])}
const SPAN=(2*(maxR+RING)+1)*P;

// ---- Scene
const renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);document.body.prepend(renderer.domElement);
const scene=new T.Scene();
const sky=document.createElement('canvas');sky.width=2;sky.height=256;const sg=sky.getContext('2d');const gr=sg.createLinearGradient(0,0,0,256);
gr.addColorStop(0,'#090b1a');gr.addColorStop(.45,'#2a1c48');gr.addColorStop(.6,'#7a3256');gr.addColorStop(.68,'#e07a48');gr.addColorStop(.7,'#1a1420');gr.addColorStop(1,'#05060a');sg.fillStyle=gr;sg.fillRect(0,0,2,256);
scene.background=new T.CanvasTexture(sky);scene.background.colorSpace=T.SRGBColorSpace;
const FOG=new T.Color('#1a1226');scene.fog=new T.Fog(FOG,SPAN*.3,SPAN*1.1);
const camera=new T.PerspectiveCamera(45,innerWidth/innerHeight,1,SPAN*6);
const controls=new MapControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.07;controls.maxPolarAngle=Math.PI*.47;controls.minDistance=20;controls.maxDistance=SPAN*1.1;controls.zoomSpeed=1.2;controls.rotateSpeed=.6;controls.screenSpacePanning=false;
const cityR=(maxR+.5)*P;const HOME={pos:new T.Vector3(cityR*1.05,cityR*.62,cityR*1.3),target:new T.Vector3(0,cityR*.12,0)};camera.position.copy(HOME.pos);controls.target.copy(HOME.target);

// ground, streets, sidewalks
const ground=new T.Mesh(new T.PlaneGeometry(SPAN*8,SPAN*8),new T.MeshBasicMaterial({color:'#08090d'}));ground.rotation.x=-Math.PI/2;scene.add(ground);
const hue=new Map(groups.map((g,i)=>[g.id,(i*67+190)%360]));
const curb=new T.InstancedMesh(new T.BoxGeometry(1,1,1),new T.MeshBasicMaterial(),blocks.length+filler.length);
[...blocks.map(b=>[b.x,b.z,new T.Color().setHSL(hue.get(b.g)/360,.5,.085)]),...filler.map(([x,z])=>[x,z,'#101116'])].forEach(([x,z,c],i)=>{curb.setMatrixAt(i,new T.Matrix4().compose(new T.Vector3(x+B/2,.35,z+B/2),new T.Quaternion(),new T.Vector3(B+3,.7,B+3)));curb.setColorAt(i,new T.Color(c))});scene.add(curb);
// one glowing border around each whole neighbourhood (only on sides that face another neighbourhood or open ground)
const fence=[];for(const [k,b] of taken){const [i,j]=k.split(',').map(Number);const cx=i*P,cz=j*P,o=B/2+5;
  for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1]]){if(taken.get(key(i+di,j+dj))?.g===b.g)continue;fence.push([cx+di*o,cz+dj*o,di!==0,b.g])}}
const fenceMesh=new T.InstancedMesh(new T.BoxGeometry(1,1,1),new T.MeshBasicMaterial(),Math.max(fence.length,1));fenceMesh.count=fence.length;
fence.forEach(([x,z,vert,g],i)=>{fenceMesh.setMatrixAt(i,new T.Matrix4().compose(new T.Vector3(x,.9,z),new T.Quaternion(),vert?new T.Vector3(1,.5,P+1):new T.Vector3(P+1,.5,1)));fenceMesh.setColorAt(i,new T.Color().setHSL(hue.get(g)/360,.9,.6))});scene.add(fenceMesh);
const lo=-(maxR+RING)*P-B/2-ST/2,hi=(maxR+RING+1)*P-B/2-ST/2,lines=[];for(let v=lo;v<=hi+1;v+=P)lines.push(v);
const dashGeo=new T.BoxGeometry(3,.05,.35);const dashes=[];
for(const c of lines){for(let t=lo;t<hi;t+=8){dashes.push([c,t+4,0]);dashes.push([t+4,c,1])}}
const dash=new T.InstancedMesh(dashGeo,new T.MeshBasicMaterial({color:'#5e4e34'}),dashes.length);
dashes.forEach(([a,b,r],i)=>{dash.setMatrixAt(i,new T.Matrix4().compose(new T.Vector3(a,.06,b),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),r?0:Math.PI/2),new T.Vector3(1,1,1)))});scene.add(dash);
const snap=v=>lo+Math.round((v-lo)/P)*P;
// street lamps at every corner
const lampPts=[];for(const x of lines)for(const z of lines){for(const [dx,dz] of [[-5,-5],[5,5]])lampPts.push(x+dx,5,z+dz)}
const glowTex=(()=>{const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d');const r=g.createRadialGradient(32,32,0,32,32,32);r.addColorStop(0,'rgba(255,255,255,1)');r.addColorStop(.25,'rgba(255,255,255,.55)');r.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=r;g.fillRect(0,0,64,64);return new T.CanvasTexture(c)})();
const lampGeo=new T.BufferGeometry();lampGeo.setAttribute('position',new T.Float32BufferAttribute(lampPts,3));
scene.add(new T.Points(lampGeo,new T.PointsMaterial({color:'#ffb766',size:4.5,map:glowTex,transparent:true,depthWrite:false,blending:T.AdditiveBlending})));
// parks
const parkMesh=new T.InstancedMesh(new T.BoxGeometry(1,1,1),new T.MeshBasicMaterial({color:'#0f2a1c'}),Math.max(parks.length,1));
const trees=[];parks.forEach(([x,z],i)=>{parkMesh.setMatrixAt(i,new T.Matrix4().compose(new T.Vector3(x+B/2,.4,z+B/2),new T.Quaternion(),new T.Vector3(B,.8,B)));for(let k=0;k<9;k++){const h=hash(x+':'+z+':'+k);trees.push([x+5+((k%3)*12)+h*3,z+5+(Math.floor(k/3)*12)+hash(k+':'+x)*3,3+h*3])}});
parkMesh.count=parks.length;scene.add(parkMesh);
const treeMesh=new T.InstancedMesh(new T.ConeGeometry(1.8,1,6),new T.MeshBasicMaterial({color:'#164a2c'}),Math.max(trees.length,1));
trees.forEach(([x,z,h],i)=>treeMesh.setMatrixAt(i,new T.Matrix4().compose(new T.Vector3(x,.8+h/2,z),new T.Quaternion(),new T.Vector3(1,h,1))));treeMesh.count=trees.length;scene.add(treeMesh);

// ---- Buildings: one instanced mesh, windows drawn by the shader from world position.
const maxScore=Math.max(1,...Object.values(D.files).map(r=>r.users+weight(r)*2));
const bfiles=[];const bgeo=new T.BoxGeometry(1,1,1);bgeo.translate(0,.5,0);
const seeds=[],stats=[],sizes=[],states=[],gidx=[];const mats=[];
for(const b of blocks){b.files.forEach((f,k)=>{const r=D.files[f];const lx=k%K,lz=Math.floor(k/K);const h1=hash(f);const set=.9+h1*.9;
  const w=LOT-set*2,d=LOT-set*2-hash(f+'d')*1.5;const score=(r.users+weight(r)*2)/maxScore;
  const H=Math.max(5,7+85*Math.sqrt(score)*(.8+h1*.4)+h1*6);
  const pos=new T.Vector3(b.x+lx*LOT+LOT/2,.7,b.z+lz*LOT+LOT/2);
  mats.push(new T.Matrix4().compose(pos,new T.Quaternion(),new T.Vector3(w,H,d)));bfiles.push({f,pos,H,block:b});
  seeds.push(Math.floor(h1*997));gidx.push(groups.findIndex(x=>x.id===b.g));stats.push(status(r));sizes.push(w,H,d);states.push(0)})}
const nData=bfiles.length;
for(const [x,z,ring] of filler){for(let k=0;k<PER;k++){const h1=hash(x+':'+z+':'+k);if(h1<.08)continue;const lx=k%K,lz=Math.floor(k/K);const set=.8+h1*1.2;
  const w=LOT-set*2,d=LOT-set*2;const H=ring<=3?5+hash(k+'h'+x+z)*6*ring:14+Math.pow(hash(k+'h'+x+z),1.5)*(40+ring*20);
  mats.push(new T.Matrix4().compose(new T.Vector3(x+lx*LOT+LOT/2,.7,z+lz*LOT+LOT/2),new T.Quaternion(),new T.Vector3(w,Math.max(5,H),d)));seeds.push(Math.floor(h1*997));gidx.push(-1);stats.push(-1);states.push(0)}}
const bmat=new T.ShaderMaterial({uniforms:{uTime:{value:0},uFocus:{value:-1},fogColor:{value:FOG},fogNear:{value:scene.fog.near},fogFar:{value:scene.fog.far}},
 vertexShader:\`attribute float aGroup;varying float vGroup;attribute float aSeed;attribute float aStatus;attribute float aState;varying vec3 vPos;varying vec3 vN;varying vec3 vL;varying float vSeed;varying float vStatus;varying float vState;varying float vDepth;
 void main(){vec4 wp=modelMatrix*instanceMatrix*vec4(position,1.);vPos=wp.xyz;vN=normalize(mat3(instanceMatrix)*normal);vL=position;vSeed=aSeed;vGroup=aGroup;vStatus=aStatus;vState=aState;vec4 mv=viewMatrix*wp;vDepth=-mv.z;gl_Position=projectionMatrix*mv;}\`,
 fragmentShader:\`uniform float uTime;uniform float uFocus;varying float vGroup;uniform vec3 fogColor;uniform float fogNear;uniform float fogFar;varying vec3 vPos;varying vec3 vN;varying vec3 vL;varying float vSeed;varying float vStatus;varying float vState;varying float vDepth;
 float h(vec2 p){p=mod(p,251.);return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
 void main(){vec3 n=normalize(vN);float sd=floor(vSeed+.5);vec3 wall=vec3(.012,.013,.02)+.012*h(vec2(sd,3.));vec3 sc=vStatus>1.5?vec3(1.,.72,.22):vec3(1.,.22,.28);vec3 col;
  if(n.y>.5){col=wall*.8;vec2 uv=vL.xz+.5;float e=min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y));
    if(vStatus>.5){col+=sc*smoothstep(.09,.0,e)*2.6;col+=sc*.08*(.7+.3*sin(uTime*3.+sd));}else col+=vec3(.25,.3,.4)*smoothstep(.05,.0,e)*.15;}
  else{float u=abs(n.x)>.5?vPos.z:vPos.x;float v=vPos.y-.7;vec2 c=vec2(floor(u/1.7),floor(v/2.6));vec2 f=vec2(fract(u/1.7),fract(v/2.6));
    float win=step(.18,f.x)*step(f.x,.82)*step(.28,f.y)*step(f.y,.78);float lit=step(vStatus<-.5?.9:.5,h(c+sd*7.));
    vec3 wc=mix(vec3(1.,.78,.46),vec3(.62,.82,1.),step(.62,h(c*1.9+sd)));if(vStatus>.5)wc=mix(wc,sc,.72);
    float sh=abs(n.x)>.5?.72:1.;col=wall*sh+win*lit*wc*(.55+.5*h(c+3.1))*(vStatus<-.5?.28:1.)+win*(1.-lit)*vec3(.006,.008,.014);
    if(vStatus>-.5)col+=vec3(1.,.55,.25)*.08*smoothstep(2.2,0.,v);if(vStatus>.5)col+=sc*.1*smoothstep(6.,0.,abs(v-floor(v/40.)*40.)*0.);}
  if(vState>.5){float a=n.y>.5?max(abs(vL.x),abs(vL.z)):(abs(n.x)>.5?abs(vL.z):abs(vL.x));float rim=smoothstep(.44,.5,a)+(n.y>.5?0.:smoothstep(.985,1.,vL.y));col+=vec3(.3,.85,1.)*(rim*1.4+.02)*(vState>1.5?1.:.55);}
  if(uFocus>-.5&&abs(vGroup-uFocus)>.5)col*=.22;float fg=smoothstep(fogNear,fogFar,vDepth);gl_FragColor=vec4(mix(col,fogColor,fg),1.);}\`});
const bmesh=new T.InstancedMesh(bgeo,bmat,mats.length);mats.forEach((m,i)=>bmesh.setMatrixAt(i,m));
bgeo.setAttribute('aGroup',new T.InstancedBufferAttribute(new Float32Array(gidx),1));bgeo.setAttribute('aSeed',new T.InstancedBufferAttribute(new Float32Array(seeds),1));bgeo.setAttribute('aStatus',new T.InstancedBufferAttribute(new Float32Array(stats),1));
const stateAttr=new T.InstancedBufferAttribute(new Float32Array(states),1);stateAttr.setUsage(T.DynamicDrawUsage);bgeo.setAttribute('aState',stateAttr);scene.add(bmesh);
// rooftop beacons on red and amber buildings
const bc=[],bcol=[];bfiles.forEach(b=>{const s=status(D.files[b.f]);if(!s)return;bc.push(b.pos.x,b.pos.y+b.H+2.5,b.pos.z);const c=new T.Color(s===1?'#ff3b4e':'#ffb52e');bcol.push(c.r,c.g,c.b)});
const bcGeo=new T.BufferGeometry();bcGeo.setAttribute('position',new T.Float32BufferAttribute(bc,3));bcGeo.setAttribute('color',new T.Float32BufferAttribute(bcol,3));
const beaconMat=new T.PointsMaterial({size:16,map:glowTex,vertexColors:true,transparent:true,depthWrite:false,blending:T.AdditiveBlending});scene.add(new T.Points(bcGeo,beaconMat));

// ---- Traffic: imports between neighbourhoods drive along the streets between them.
const owner={};blocks.forEach(b=>b.files.forEach(f=>owner[f]=b.g));
const centre={};for(const g of groups){const bs=blocks.filter(b=>b.g===g.id);centre[g.id]=[bs.reduce((s,b)=>s+b.x+B/2,0)/bs.length,bs.reduce((s,b)=>s+b.z+B/2,0)/bs.length,bs]}
const links=new Map();for(const [a,b] of D.edges){const A=owner[a],Bq=owner[b];if(!A||!Bq||A===Bq)continue;const k=[A,Bq].sort().join('|');links.set(k,(links.get(k)??0)+1)}
const routes=[];for(const [k,c] of links){const [A,Bq]=k.split('|');const a=centre[A],b=centre[Bq];const p0=[snap(a[0]),snap(a[1])],p2=[snap(b[0]),snap(b[1])];
  const pts=[p0,[p2[0],p0[1]],p2];const len=Math.abs(p2[0]-p0[0])+Math.abs(p2[1]-p0[1]);if(len<1)continue;routes.push({pts,len,count:Math.min(40,4+c*3)})}
const cars=[];routes.forEach((r,ri)=>{for(let i=0;i<r.count;i++)cars.push({r:ri,t:hash(ri+':'+i),dir:i%2?1:-1,speed:.04+hash(i+':'+ri)*.05})});
const carMesh=new T.InstancedMesh(new T.BoxGeometry(2.2,.9,1.2),new T.MeshBasicMaterial({color:'#ffffff'}),Math.max(cars.length,1));carMesh.count=cars.length;
const carCol=new T.Color();cars.forEach((c,i)=>carMesh.setColorAt(i,carCol.set(c.dir>0?'#fff4d6':'#ff4a4a')));scene.add(carMesh);
const at=(r,t)=>{const s=t*r.len;const [a,b,c]=r.pts;const l1=Math.abs(b[0]-a[0]);if(s<=l1)return [a[0]+Math.sign(b[0]-a[0])*s,a[1],0];const s2=s-l1;return [b[0],b[1]+Math.sign(c[1]-b[1])*s2,1]};
const tmpM=new T.Matrix4(),tmpQ=new T.Quaternion(),tmpS=new T.Vector3(1,1,1),tmpP=new T.Vector3(),Y=new T.Vector3(0,1,0);
function moveCars(dt){cars.forEach((c,i)=>{const r=routes[c.r];c.t=(c.t+c.dir*c.speed*dt*40/r.len+1)%1;const [x,z,leg]=at(r,c.t);const lane=c.dir*2.4;
  tmpP.set(leg?x+lane:x,.9,leg?z:z+lane);tmpQ.setFromAxisAngle(Y,leg?Math.PI/2:0);carMesh.setMatrixAt(i,tmpM.compose(tmpP,tmpQ,tmpS))});carMesh.instanceMatrix.needsUpdate=true}

// ---- Bloom
const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
const bloom=new UnrealBloomPass(new T.Vector2(innerWidth/2,innerHeight/2),.85,.45,.6);composer.addPass(bloom);composer.addPass(new OutputPass());

// ---- Labels: neighbourhood signs always; folder signs when the camera is close.
const labels=document.getElementById('labels');const tags=[];const redraws=[];const touch=matchMedia('(pointer:coarse)').matches;const narrow=()=>document.documentElement.classList.contains('m');
const stat=fs=>{let red=0,amber=0;for(const f of fs){const s=status(D.files[f]);if(s===1)red++;else if(s===2)amber++}return {red,amber}};
for(const g of groups){const [x,z,bs]=centre[g.id];const top=Math.max(...bfiles.filter(b=>b.block.g===g.id).map(b=>b.H));const s=stat(g.files);
  const el=document.createElement('div');el.className='hood';el.style.setProperty('--h',hue.get(g.id));const draw=()=>{el.innerHTML=esc(gname(g.id)??g.id)+'<small>'+(gname(g.id)?esc(g.id)+' · ':'')+t('files')(g.files.length)+(s.red?' · <span class="w">'+t('risk')(s.red)+'</span>':'')+(s.amber?' · <span class="r">'+t('rule')(s.amber)+'</span>':'')+'</small>'};draw();redraws.push(draw);
  el.onclick=()=>{flyTo(x,z,Math.sqrt(bs.length)*P*1.6+60);focusOn(g.id);showHood(g,true)};el.onmouseenter=()=>{if(!touch)showHood(g)};labels.appendChild(el);tags.push({el,p:new T.Vector3(x,Math.min(top,45)+12,z),near:Infinity})}
for(const b of blocks){const name=b.dirs[0].split('/').pop()+(b.dirs.length>1?' +'+(b.dirs.length-1):'');const top=Math.max(...bfiles.filter(x=>x.block===b).map(x=>x.H));
  const el=document.createElement('div');el.className='street';el.textContent=name;el.title=b.dirs.join(', ');el.onclick=()=>flyTo(b.x+B/2,b.z+B/2,120);labels.appendChild(el);tags.push({el,p:new T.Vector3(b.x+B/2,top+6,b.z+B/2),near:260})}
const v=new T.Vector3();
function placeLabels(){const dist=camera.position.distanceTo(controls.target);for(const t of tags){v.copy(t.p).project(camera);const vis=v.z<1&&dist<t.near&&Math.abs(v.x)<1.1&&Math.abs(v.y)<1.1;
  t.el.style.display=vis?'block':'none';if(vis){t.el.style.left=((v.x+1)/2*innerWidth/window.__ui)+'px';t.el.style.top=((1-v.y)/2*innerHeight/window.__ui)+'px'}}}

// ---- Panel
const noLabels=()=>lang!=='en'&&!LL().text?'<p class="hint">'+t('noLabels')+'</p>':'';
const note=x=>'<div class="label"><small class="mine">'+t('mine')+'</small>'+esc(x)+'</div>';
const side=document.getElementById('side'),pt=document.getElementById('pt'),pb=document.getElementById('pb');let current=null;
// show: true opens the panel (a click or tap); false only refreshes it if it is already showing (hover).
function setPanel(title,html,show){if(!show&&!side.classList.contains('shown'))return;pt.textContent=title;pb.innerHTML=html;pb.scrollTop=0;if(show){side.classList.add('shown');if(narrow())side.classList.add('open')}}
document.getElementById('ph').onclick=e=>{if(e.target.id==='px'){side.classList.remove('shown','open');return}if(narrow())side.classList.toggle('open')};
function focusOn(id){bmat.uniforms.uFocus.value=id==null?-1:groups.findIndex(x=>x.id===id)}
const fileLink=p=>D.files[p]?'<a class="fl" data-f="'+esc(p)+'">'+esc(p)+'</a>':'<span class="k">'+esc(p)+'</span>';
function showHood(g,show){current=()=>showHood(g,false);const s=stat(g.files);let h='<div class="sub">'+t('hood')+' · '+t('bld')(g.files.length)+' · '+t('wRisk')(s.red)+' · '+t('wRule')(s.amber)+'</div>'+(PL().groups?.[g.id]?.about?note(PL().groups[g.id].about):g.title?'<div class="label">'+esc(tr(g.title))+'</div>':'')+noLabels();
  if(g.risks.length)h+='<h3>## '+t('hRisk')+'</h3><ul>'+g.risks.map(([x,fs])=>'<li class="w" title="'+esc(x)+'">'+esc(tr(x))+(fs.length?'<div class="on">'+fs.map(fileLink).join(' ')+'</div>':'')+'</li>').join('')+'</ul>';
  if(g.rules.length)h+='<h3>## '+t('hRule')+'</h3><ul>'+g.rules.map(x=>'<li><span class="rr">'+esc(x[0])+'</span>: '+esc(tr(x[1]))+(x[2]?' <span class="hint">— '+t('why')+': '+esc(tr(x[2]))+'</span>':'')+'</li>').join('')+'</ul>';
  if(g.checks.length)h+='<h3>## '+t('hCheck')+'</h3><ul>'+g.checks.map(x=>'<li><span class="k">'+esc(x[0])+'</span>'+(x[1]?' <span class="hint">— '+esc(tr(x[1]))+'</span>':'')+'</li>').join('')+'</ul>';
  setPanel(gname(g.id)?gname(g.id)+' · '+g.id:g.id,h+'<p class="hint">'+t('hint')+'</p>',show)}
function showFile(f,show){current=()=>showFile(f,false);const r=D.files[f];let h='<div class="sub">'+esc(r.g)+(r.users?' · '+t('usedBy')(r.users):'')+'</div>';
  if(PL().files?.[f])h+=note(PL().files[f]);h+=noLabels();
  if(r.risks.length)h+='<h3>## '+t('hRisk')+'</h3><ul>'+r.risks.map(x=>'<li class="w" title="'+esc(x)+'">'+esc(tr(x))+'</li>').join('')+'</ul>';
  if(r.rules.length)h+='<h3>## '+t('hRule')+'</h3><ul>'+r.rules.map(x=>'<li><span class="rr">'+esc(x[0])+'</span>: '+esc(tr(x[1]))+(x[2]?' <span class="hint">— '+t('why')+': '+esc(tr(x[2]))+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.checks.length)h+='<h3>## '+t('hCheck')+'</h3><ul>'+r.checks.map(x=>'<li><span class="k">'+esc(x[0])+'</span>'+(x[1]?' <span class="hint">— '+esc(tr(x[1]))+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.tests.length)h+='<h3>## '+t('hTest')+'</h3><ul>'+r.tests.map(x=>'<li class="k">'+esc(x)+'</li>').join('')+'</ul>';
  if(!r.risks.length&&!r.rules.length&&!r.checks.length&&!r.tests.length)h+='<p class="hint">'+t('none')+'</p>';setPanel(f,h,show)}
document.getElementById('mode').onclick=()=>{mode=plainOn()?'base':'plain';try{localStorage.setItem('rf-mode',mode)}catch{}applyLang();redraws.forEach(d=>d());if(current)current()};
document.getElementById('lang').onclick=()=>{lang=lang==='ko'?'en':'ko';try{localStorage.setItem('rf-lang',lang)}catch{}applyLang();redraws.forEach(d=>d());if(current)current()};

// ---- Picking
const ray=new T.Raycaster(),mouse=new T.Vector2();let hover=-1,picked=-1;
const setState=(i,s)=>{if(i<0)return;stateAttr.setX(i,s);stateAttr.needsUpdate=true};
function pick(e){const r=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(mouse,camera);const hit=ray.intersectObject(bmesh)[0];return hit&&hit.instanceId<nData?hit.instanceId:-1}
let downAt=null;renderer.domElement.addEventListener('pointerdown',e=>{downAt=[e.clientX,e.clientY]});
renderer.domElement.addEventListener('pointermove',e=>{if(e.buttons)return;const i=pick(e);if(i!==hover){if(hover!==picked)setState(hover,0);hover=i;if(i>=0&&i!==picked){setState(i,1);showFile(bfiles[i].f,false)}renderer.domElement.style.cursor=i>=0?'pointer':'grab'}});
function selectFile(i){setState(picked,0);picked=i;setState(i,2);showFile(bfiles[i].f,true);const b=bfiles[i];flyTo(b.pos.x,b.pos.z,Math.max(90,b.H*2.2))}
pb.addEventListener('click',e=>{const f=e.target.closest('a.fl')?.dataset.f;if(!f)return;const i=bfiles.findIndex(b=>b.f===f);if(i>=0)selectFile(i)});
renderer.domElement.addEventListener('pointerup',e=>{if(!downAt||Math.hypot(e.clientX-downAt[0],e.clientY-downAt[1])>5)return;const i=pick(e);if(i<0){side.classList.remove('open');focusOn(null);return}setState(picked,0);picked=i;setState(i,2);showFile(bfiles[i].f,true);const b=bfiles[i];flyTo(b.pos.x,b.pos.z,Math.max(90,b.H*2.2))});

// ---- Camera moves
let fly=null;function flyTo(x,z,dist){const tgt=new T.Vector3(x,0,z);const dir=camera.position.clone().sub(controls.target);dir.y=0;dir.normalize();dir.y=1.05;dir.normalize();fly={t:0,from:camera.position.clone(),to:tgt.clone().add(dir.multiplyScalar(dist)),ft:controls.target.clone(),tt:tgt}}
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
function turn(a){const o=camera.position.clone().sub(controls.target);o.applyAxisAngle(Y,a);fly={t:0,from:camera.position.clone(),to:controls.target.clone().add(o),ft:controls.target.clone(),tt:controls.target.clone()}}
document.getElementById('rl').onclick=()=>turn(-Math.PI/6);document.getElementById('rr').onclick=()=>turn(Math.PI/6);
const zoom=k=>{const o=camera.position.clone().sub(controls.target).multiplyScalar(k);fly={t:0,from:camera.position.clone(),to:controls.target.clone().add(o),ft:controls.target.clone(),tt:controls.target.clone()}};
document.getElementById('zi').onclick=()=>zoom(.7);document.getElementById('zo').onclick=()=>zoom(1.4);
document.getElementById('home').onclick=()=>{focusOn(null);fly={t:0,from:camera.position.clone(),to:HOME.pos.clone(),ft:controls.target.clone(),tt:HOME.target.clone()}};

addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);bloom.resolution.set(innerWidth/2,innerHeight/2)});
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const clock=new T.Clock();
function frame(){const dt=Math.min(clock.getDelta(),.05);bmat.uniforms.uTime.value+=dt;beaconMat.opacity=.65+.35*Math.sin(bmat.uniforms.uTime.value*3);
  if(!reduced)moveCars(dt);
  if(fly){fly.t=Math.min(1,fly.t+dt/.9);const k=ease(fly.t);camera.position.lerpVectors(fly.from,fly.to,k);controls.target.lerpVectors(fly.ft,fly.tt,k);if(fly.t>=1)fly=null}
  controls.update();composer.render();placeLabels();requestAnimationFrame(frame)}
moveCars(0);frame();window.__city=1;
const first=bfiles.map((b,i)=>[i,weight(D.files[b.f])]).sort((a,b)=>b[1]-a[1])[0];if(first){picked=first[0];setState(picked,2);showFile(bfiles[picked].f,!narrow())}
</script>
<script>setTimeout(()=>{if(!window.__city)document.getElementById('err').style.display='grid'},12000)</script>
</body></html>`;
}
