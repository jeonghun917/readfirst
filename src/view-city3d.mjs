// The map as a night city in WebGL. Groups are neighbourhoods of real city blocks on a street grid; every file is a
// building on a lot, taller when more depends on it. Lit windows everywhere; a red-lit building has a risk on it, an
// amber one is under a rule. Traffic on the streets between two neighbourhoods carries the imports between them.
// The page loads three.js from a CDN (pinned); the data is inlined.
const esc = (s) => String(s).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.160.0';

export function viewHtmlCity3d(data) {
  const json = JSON.stringify(data).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${esc(data.name)}: what to read before you change a file</title>
<style>
:root{--fg:#eef0f6;--muted:#9aa0b4;--red:#ff4757;--amber:#ffbe3d;--sky:#7ad7ff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:#05060a;color:var(--fg);font:14px/1.5 var(--sans)}
canvas{display:block;touch-action:none}
#top{position:fixed;left:0;right:0;top:0;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;padding:12px 16px;background:linear-gradient(#05060ae6,#05060a00);pointer-events:none;z-index:3}
#top>*{pointer-events:auto}h1{font:600 15px var(--mono);margin:0}h1 span{color:var(--muted);font-weight:400}
.legend{display:flex;flex-wrap:wrap;gap:12px;font:12px var(--mono);color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
#labels{position:fixed;inset:0;pointer-events:none;z-index:2}
.hood{position:absolute;transform:translate(-50%,-100%);font:700 13px var(--mono);letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;color:#fff;text-shadow:0 0 6px var(--sky),0 0 18px rgba(122,215,255,.7),0 1px 2px #000;pointer-events:auto;cursor:pointer;padding:2px 6px}
.hood small{display:block;text-align:center;font:500 10px var(--mono);letter-spacing:0;text-transform:none;color:#d6dbe8;text-shadow:0 1px 2px #000}
.hood small .w{color:#ff8994}.hood small .r{color:var(--amber)}
.street{position:absolute;transform:translate(-50%,-100%);font:600 11px var(--mono);color:#e9eefb;background:#0b0e18cc;border:1px solid #2c3550;border-radius:4px;padding:1px 6px;white-space:nowrap;pointer-events:auto;cursor:pointer}
.panel{position:fixed;right:14px;top:58px;bottom:14px;width:360px;background:#0a0c14eb;border:1px solid #232a3d;border-radius:12px;padding:16px 18px;overflow:auto;z-index:3;backdrop-filter:blur(6px)}
.panel h2{font:600 13px var(--mono);margin:0 0 4px;word-break:break-all}.panel .sub{color:var(--muted);font:12px var(--mono);margin-bottom:10px}
.panel .label{background:#151a28;border:1px solid #29304a;border-radius:6px;padding:8px 10px;margin:8px 0 4px;color:#d9e2ff}
.panel h3{font:600 12px var(--mono);margin:14px 0 6px;color:var(--sky)}.panel ul{margin:0;padding-left:16px}.panel li{margin:3px 0}
.k{color:#8be9c9;font-family:var(--mono)}.rr{color:var(--amber);font-family:var(--mono)}.w{color:#ff8994}.hint{color:var(--muted)}
.ctl{position:fixed;left:14px;bottom:14px;display:flex;gap:6px;z-index:3}
.ctl button{width:40px;height:40px;border-radius:10px;border:1px solid #39405a;background:#121624e6;color:#dfe5f5;font:16px var(--mono);cursor:pointer}
.ctl button:hover{border-color:var(--sky)}
.tip{position:fixed;left:14px;bottom:62px;font:12px var(--mono);color:var(--muted);z-index:3;pointer-events:none}
#err{position:fixed;inset:0;display:none;place-items:center;text-align:center;color:var(--muted);font:13px var(--mono)}
@media (max-width:820px){.panel{left:10px;right:10px;top:auto;bottom:10px;width:auto;max-height:38vh}.ctl{bottom:auto;top:96px;left:10px}.tip{display:none}}
</style>
<script type="importmap">{"imports":{"three":"${THREE}/build/three.module.js","three/addons/":"${THREE}/examples/jsm/"}}</script>
</head><body>
<div id="top"><h1>${esc(data.name)} <span>· what to read before you change a file</span></h1>
<div class="legend"><span><i style="background:var(--red);box-shadow:0 0 8px var(--red)"></i>risk on this building</span><span><i style="background:var(--amber);box-shadow:0 0 8px var(--amber)"></i>a rule covers it</span><span><i style="background:#fff;box-shadow:0 0 6px #fff"></i>traffic = imports between neighbourhoods</span></div></div>
<div id="labels"></div><aside class="panel" id="side"></aside>
<div class="tip">drag to move · right-drag or two fingers to turn · wheel or pinch to zoom · click a neighbourhood to fly there</div>
<div class="ctl"><button id="rl" title="turn left">⟲</button><button id="rr" title="turn right">⟳</button><button id="zo" title="zoom out">−</button><button id="zi" title="zoom in">+</button><button id="home" title="whole city">⌂</button></div>
<div id="err">This view needs WebGL and a connection to load three.js.</div>
<script type="module">
import * as T from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
const D=${json};const L=D.labels||{};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
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
const R=Math.ceil(Math.sqrt(blocks.length*1.15)/2)+1;const RING=8;const n=2*(R+RING)+1;
const taken=new Map();const key=(i,j)=>i+','+j;const d0=(i,j)=>Math.hypot(i,j*1.05);
const near=[];for(let i=-R;i<=R;i++)for(let j=-R;j<=R;j++)near.push([i,j]);near.sort((a,b)=>d0(...a)-d0(...b));
let gi=0;for(const g of groups){const mine=blocks.filter(b=>b.g===g.id);const seed=near.find(c=>!taken.has(key(...c)));const region=[];
  for(const b of mine){let best=null,bd=Infinity;const cand=region.length?region.flatMap(([i,j])=>[[i+1,j],[i-1,j],[i,j+1],[i,j-1]]):[seed];
    for(const c of cand){if(taken.has(key(...c))||Math.abs(c[0])>R||Math.abs(c[1])>R)continue;const d=Math.hypot(c[0]-seed[0],c[1]-seed[1])+d0(...c)*.35;if(d<bd){bd=d;best=c}}
    if(!best)best=near.find(c=>!taken.has(key(...c)));taken.set(key(...best),b);region.push(best);b.cell=best}
  gi++}
const off=-(n*P)/2+ST/2;const cellXY=([i,j])=>[(i)*P-B/2,(j)*P-B/2];
blocks.forEach(b=>{[b.x,b.z]=cellXY(b.cell)});
const used=[...taken.keys()].map(k=>k.split(',').map(Number));const maxR=Math.max(...used.map(([i,j])=>Math.max(Math.abs(i),Math.abs(j))));
const parks=[],filler=[];
const maxD=Math.max(...used.map(([i,j])=>Math.hypot(i,j)));
for(let i=-(maxR+RING);i<=maxR+RING;i++)for(let j=-(maxR+RING);j<=maxR+RING;j++){if(taken.has(key(i,j)))continue;
  const d=Math.hypot(i,j);const h=hash(i+':'+j);
  if(d<=maxD-.5||h<.08)parks.push(cellXY([i,j]));else filler.push([...cellXY([i,j]),Math.max(1,Math.round(d-maxD+.5))])}
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
[...blocks.map(b=>[b.x,b.z,'#15161d']),...filler.map(([x,z])=>[x,z,'#101116'])].forEach(([x,z,c],i)=>{curb.setMatrixAt(i,new T.Matrix4().compose(new T.Vector3(x+B/2,.35,z+B/2),new T.Quaternion(),new T.Vector3(B+3,.7,B+3)));curb.setColorAt(i,new T.Color(c))});scene.add(curb);
// a neon line around every block, in its neighbourhood's colour
const edgePts=[],edgeCol=[];blocks.forEach(b=>{const c=new T.Color().setHSL(hue.get(b.g)/360,.85,.55);const x0=b.x-1.2,z0=b.z-1.2,x1=b.x+B+1.2,z1=b.z+B+1.2;
  for(const [a,bb,cc,dd] of [[x0,z0,x1,z0],[x1,z0,x1,z1],[x1,z1,x0,z1],[x0,z1,x0,z0]]){edgePts.push(a,.75,bb,cc,.75,dd);edgeCol.push(c.r,c.g,c.b,c.r,c.g,c.b)}});
const edgeGeo=new T.BufferGeometry();edgeGeo.setAttribute('position',new T.Float32BufferAttribute(edgePts,3));edgeGeo.setAttribute('color',new T.Float32BufferAttribute(edgeCol,3));
scene.add(new T.LineSegments(edgeGeo,new T.LineBasicMaterial({vertexColors:true})));
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
const seeds=[],stats=[],sizes=[],states=[];const mats=[];
for(const b of blocks){b.files.forEach((f,k)=>{const r=D.files[f];const lx=k%K,lz=Math.floor(k/K);const h1=hash(f);const set=.9+h1*.9;
  const w=LOT-set*2,d=LOT-set*2-hash(f+'d')*1.5;const score=(r.users+weight(r)*2)/maxScore;
  const H=Math.max(5,7+85*Math.sqrt(score)*(.8+h1*.4)+h1*6);
  const pos=new T.Vector3(b.x+lx*LOT+LOT/2,.7,b.z+lz*LOT+LOT/2);
  mats.push(new T.Matrix4().compose(pos,new T.Quaternion(),new T.Vector3(w,H,d)));bfiles.push({f,pos,H,block:b});
  seeds.push(Math.floor(h1*997));stats.push(status(r));sizes.push(w,H,d);states.push(0)})}
const nData=bfiles.length;
for(const [x,z,ring] of filler){for(let k=0;k<PER;k++){const h1=hash(x+':'+z+':'+k);if(h1<.08)continue;const lx=k%K,lz=Math.floor(k/K);const set=.8+h1*1.2;
  const w=LOT-set*2,d=LOT-set*2;const H=ring<=3?5+hash(k+'h'+x+z)*6*ring:14+Math.pow(hash(k+'h'+x+z),1.5)*(40+ring*20);
  mats.push(new T.Matrix4().compose(new T.Vector3(x+lx*LOT+LOT/2,.7,z+lz*LOT+LOT/2),new T.Quaternion(),new T.Vector3(w,Math.max(5,H),d)));seeds.push(Math.floor(h1*997));stats.push(-1);states.push(0)}}
const bmat=new T.ShaderMaterial({uniforms:{uTime:{value:0},fogColor:{value:FOG},fogNear:{value:scene.fog.near},fogFar:{value:scene.fog.far}},
 vertexShader:\`attribute float aSeed;attribute float aStatus;attribute float aState;varying vec3 vPos;varying vec3 vN;varying vec3 vL;varying float vSeed;varying float vStatus;varying float vState;varying float vDepth;
 void main(){vec4 wp=modelMatrix*instanceMatrix*vec4(position,1.);vPos=wp.xyz;vN=normalize(mat3(instanceMatrix)*normal);vL=position;vSeed=aSeed;vStatus=aStatus;vState=aState;vec4 mv=viewMatrix*wp;vDepth=-mv.z;gl_Position=projectionMatrix*mv;}\`,
 fragmentShader:\`uniform float uTime;uniform vec3 fogColor;uniform float fogNear;uniform float fogFar;varying vec3 vPos;varying vec3 vN;varying vec3 vL;varying float vSeed;varying float vStatus;varying float vState;varying float vDepth;
 float h(vec2 p){p=mod(p,251.);return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
 void main(){vec3 n=normalize(vN);float sd=floor(vSeed+.5);vec3 wall=vec3(.012,.013,.02)+.012*h(vec2(sd,3.));vec3 sc=vStatus>1.5?vec3(1.,.72,.22):vec3(1.,.22,.28);vec3 col;
  if(n.y>.5){col=wall*.8;vec2 uv=vL.xz+.5;float e=min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y));
    if(vStatus>.5){col+=sc*smoothstep(.09,.0,e)*2.6;col+=sc*.08*(.7+.3*sin(uTime*3.+sd));}else col+=vec3(.25,.3,.4)*smoothstep(.05,.0,e)*.15;}
  else{float u=abs(n.x)>.5?vPos.z:vPos.x;float v=vPos.y-.7;vec2 c=vec2(floor(u/1.7),floor(v/2.6));vec2 f=vec2(fract(u/1.7),fract(v/2.6));
    float win=step(.18,f.x)*step(f.x,.82)*step(.28,f.y)*step(f.y,.78);float lit=step(vStatus<-.5?.72:.5,h(c+sd*7.));
    vec3 wc=mix(vec3(1.,.78,.46),vec3(.62,.82,1.),step(.62,h(c*1.9+sd)));if(vStatus>.5)wc=mix(wc,sc,.72);
    float sh=abs(n.x)>.5?.72:1.;col=wall*sh+win*lit*wc*(.55+.5*h(c+3.1))*(vStatus<-.5?.7:1.)+win*(1.-lit)*vec3(.006,.008,.014);
    col+=vec3(1.,.55,.25)*.08*smoothstep(2.2,0.,v);if(vStatus>.5)col+=sc*.1*smoothstep(6.,0.,abs(v-floor(v/40.)*40.)*0.);}
  if(vState>.5){float a=n.y>.5?max(abs(vL.x),abs(vL.z)):(abs(n.x)>.5?abs(vL.z):abs(vL.x));float rim=smoothstep(.44,.5,a)+(n.y>.5?0.:smoothstep(.985,1.,vL.y));col+=vec3(.3,.85,1.)*(rim*1.4+.02)*(vState>1.5?1.:.55);}
  float fg=smoothstep(fogNear,fogFar,vDepth);gl_FragColor=vec4(mix(col,fogColor,fg),1.);}\`});
const bmesh=new T.InstancedMesh(bgeo,bmat,mats.length);mats.forEach((m,i)=>bmesh.setMatrixAt(i,m));
bgeo.setAttribute('aSeed',new T.InstancedBufferAttribute(new Float32Array(seeds),1));bgeo.setAttribute('aStatus',new T.InstancedBufferAttribute(new Float32Array(stats),1));
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
const labels=document.getElementById('labels');const tags=[];
const stat=fs=>{let red=0,amber=0;for(const f of fs){const s=status(D.files[f]);if(s===1)red++;else if(s===2)amber++}return {red,amber}};
for(const g of groups){const [x,z,bs]=centre[g.id];const top=Math.max(...bfiles.filter(b=>b.block.g===g.id).map(b=>b.H));const s=stat(g.files);
  const el=document.createElement('div');el.className='hood';el.innerHTML=esc(g.id)+'<small>'+g.files.length+' files'+(s.red?' · <span class="w">'+s.red+' risk</span>':'')+(s.amber?' · <span class="r">'+s.amber+' rule</span>':'')+'</small>';
  el.onclick=()=>{flyTo(x,z,Math.sqrt(bs.length)*P*1.6+60);showHood(g)};el.onmouseenter=()=>showHood(g);labels.appendChild(el);tags.push({el,p:new T.Vector3(x,top+14,z),near:Infinity})}
for(const b of blocks){const name=b.dirs[0].split('/').pop()+(b.dirs.length>1?' +'+(b.dirs.length-1):'');const top=Math.max(...bfiles.filter(x=>x.block===b).map(x=>x.H));
  const el=document.createElement('div');el.className='street';el.textContent=name;el.title=b.dirs.join(', ');el.onclick=()=>flyTo(b.x+B/2,b.z+B/2,120);labels.appendChild(el);tags.push({el,p:new T.Vector3(b.x+B/2,top+6,b.z+B/2),near:260})}
const v=new T.Vector3();
function placeLabels(){const dist=camera.position.distanceTo(controls.target);for(const t of tags){v.copy(t.p).project(camera);const vis=v.z<1&&dist<t.near&&Math.abs(v.x)<1.1&&Math.abs(v.y)<1.1;
  t.el.style.display=vis?'block':'none';if(vis){t.el.style.left=((v.x+1)/2*innerWidth)+'px';t.el.style.top=((1-v.y)/2*innerHeight)+'px'}}}

// ---- Panel
const side=document.getElementById('side');
function showHood(g){const s=stat(g.files);side.innerHTML='<h2>'+esc(g.id)+'</h2><div class="sub">neighbourhood · '+g.files.length+' buildings · '+s.red+' with a risk · '+s.amber+' under a rule</div>'+((L[g.id]||g.title)?'<div class="label">'+esc(L[g.id]||g.title)+'</div>':'')+'<p class="hint">Point at a building to see what to read before changing that file.</p>'}
function showFile(f){const r=D.files[f];let h='<h2>'+esc(f)+'</h2><div class="sub">'+esc(r.g)+(r.users?' · used by '+r.users+' file'+(r.users>1?'s':''):'')+'</div>';
  if(L[f])h+='<div class="label">'+esc(L[f])+'</div>';
  if(r.risks.length)h+='<h3>## Watch out</h3><ul>'+r.risks.map(x=>'<li class="w">'+esc(x)+'</li>').join('')+'</ul>';
  if(r.rules.length)h+='<h3>## Rules that must keep holding</h3><ul>'+r.rules.map(x=>'<li><span class="rr">'+esc(x[0])+'</span>: '+esc(x[1])+(x[2]?' <span class="hint">— why: '+esc(x[2])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.checks.length)h+='<h3>## Run these checks</h3><ul>'+r.checks.map(x=>'<li><span class="k">'+esc(x[0])+'</span>'+(x[1]?' <span class="hint">— '+esc(x[1])+'</span>':'')+'</li>').join('')+'</ul>';
  if(r.tests.length)h+='<h3>## Tests that reach this code</h3><ul>'+r.tests.map(x=>'<li class="k">'+esc(x)+'</li>').join('')+'</ul>';
  if(!r.risks.length&&!r.rules.length&&!r.checks.length&&!r.tests.length)h+='<p class="hint">Nothing in the map is tied to this file yet.</p>';side.innerHTML=h}

// ---- Picking
const ray=new T.Raycaster(),mouse=new T.Vector2();let hover=-1,picked=-1;
const setState=(i,s)=>{if(i<0)return;stateAttr.setX(i,s);stateAttr.needsUpdate=true};
function pick(e){const r=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(mouse,camera);const hit=ray.intersectObject(bmesh)[0];return hit&&hit.instanceId<nData?hit.instanceId:-1}
let downAt=null;renderer.domElement.addEventListener('pointerdown',e=>{downAt=[e.clientX,e.clientY]});
renderer.domElement.addEventListener('pointermove',e=>{if(e.buttons)return;const i=pick(e);if(i!==hover){if(hover!==picked)setState(hover,0);hover=i;if(i>=0&&i!==picked){setState(i,1);showFile(bfiles[i].f)}renderer.domElement.style.cursor=i>=0?'pointer':'grab'}});
renderer.domElement.addEventListener('pointerup',e=>{if(!downAt||Math.hypot(e.clientX-downAt[0],e.clientY-downAt[1])>5)return;const i=pick(e);if(i<0)return;setState(picked,0);picked=i;setState(i,2);showFile(bfiles[i].f);const b=bfiles[i];flyTo(b.pos.x,b.pos.z,Math.max(90,b.H*2.2))});

// ---- Camera moves
let fly=null;function flyTo(x,z,dist){const tgt=new T.Vector3(x,0,z);const dir=camera.position.clone().sub(controls.target);dir.y=0;dir.normalize();dir.y=1.05;dir.normalize();fly={t:0,from:camera.position.clone(),to:tgt.clone().add(dir.multiplyScalar(dist)),ft:controls.target.clone(),tt:tgt}}
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
function turn(a){const o=camera.position.clone().sub(controls.target);o.applyAxisAngle(Y,a);fly={t:0,from:camera.position.clone(),to:controls.target.clone().add(o),ft:controls.target.clone(),tt:controls.target.clone()}}
document.getElementById('rl').onclick=()=>turn(-Math.PI/6);document.getElementById('rr').onclick=()=>turn(Math.PI/6);
const zoom=k=>{const o=camera.position.clone().sub(controls.target).multiplyScalar(k);fly={t:0,from:camera.position.clone(),to:controls.target.clone().add(o),ft:controls.target.clone(),tt:controls.target.clone()}};
document.getElementById('zi').onclick=()=>zoom(.7);document.getElementById('zo').onclick=()=>zoom(1.4);
document.getElementById('home').onclick=()=>{fly={t:0,from:camera.position.clone(),to:HOME.pos.clone(),ft:controls.target.clone(),tt:HOME.target.clone()}};

addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);bloom.resolution.set(innerWidth/2,innerHeight/2)});
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const clock=new T.Clock();
function frame(){const dt=Math.min(clock.getDelta(),.05);bmat.uniforms.uTime.value+=dt;beaconMat.opacity=.65+.35*Math.sin(bmat.uniforms.uTime.value*3);
  if(!reduced)moveCars(dt);
  if(fly){fly.t=Math.min(1,fly.t+dt/.9);const k=ease(fly.t);camera.position.lerpVectors(fly.from,fly.to,k);controls.target.lerpVectors(fly.ft,fly.tt,k);if(fly.t>=1)fly=null}
  controls.update();composer.render();placeLabels();requestAnimationFrame(frame)}
moveCars(0);frame();window.__city=1;
const first=bfiles.map((b,i)=>[i,weight(D.files[b.f])]).sort((a,b)=>b[1]-a[1])[0];if(first){picked=first[0];setState(picked,2);showFile(bfiles[picked].f)}
</script>
<script>setTimeout(()=>{if(!window.__city)document.getElementById('err').style.display='grid'},12000)</script>
</body></html>`;
}
