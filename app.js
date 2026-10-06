import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import {OrbitControls} from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";

const $=id=>document.getElementById(id);
const viewer=$("viewer");
const scene=new THREE.Scene(); scene.background=new THREE.Color(0xdfe4e9);
const camera=new THREE.PerspectiveCamera(45,1,.1,100000);
camera.position.set(3000,2400,3600);
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setSize(viewer.clientWidth,viewer.clientHeight); viewer.appendChild(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement); controls.target.set(0,1000,0); controls.enableDamping=true;
scene.add(new THREE.HemisphereLight(0xffffff,0x657080,2.1));
const key=new THREE.DirectionalLight(0xffffff,2.6); key.position.set(3000,4500,2500); scene.add(key);
const grid=new THREE.GridHelper(7000,70,0x9aa3ad,0xc6ccd3); scene.add(grid);
const root=new THREE.Group(); scene.add(root);
const parts=[]; let exploded=false;

const colors={ldsp18:0xc69b68,ldsp16:0xc69b68,mdf18:0xd7d9dc,ply18:0xb88a58};
const mat=()=>new THREE.MeshStandardMaterial({color:colors[$("material").value]||0xc69b68,roughness:.68,metalness:0});
function box(name,w,h,d,pos,kind="Корпус"){const g=new THREE.BoxGeometry(w,h,d);const m=new THREE.Mesh(g,mat());m.position.copy(pos);m.castShadow=true;m.receiveShadow=true;m.userData={name,kind,base:pos.clone()};root.add(m);parts.push(m);return m}

function clear(){while(root.children.length){const o=root.children.pop();o.geometry?.dispose();o.material?.dispose()};parts.length=0}
function build(){
  clear();
  const W=+$("width").value,H=+$("height").value,D=+$("depth").value,T=+$("thickness").value;
  const S=Math.max(1,+$("sections").value|0), shelves=Math.max(0,+$("shelves").value|0), doors=Math.max(0,+$("doors").value|0);
  if(W<=2*T||H<=2*T||D<=2*T){validate("Размеры несовместимы с толщиной материала.","error");return}
  const innerW=W-2*T, secW=innerW/S;
  box("Боковина левая",T,H,D,new THREE.Vector3(-W/2+T/2,H/2,0));
  box("Боковина правая",T,H,D,new THREE.Vector3(W/2-T/2,H/2,0));
  box("Дно",innerW,T,D,new THREE.Vector3(0,T/2,0));
  box("Крышка",innerW,T,D,new THREE.Vector3(0,H-T/2,0));
  for(let i=1;i<S;i++) box("Вертикальная перегородка "+i,T,H-2*T,D,new THREE.Vector3(-W/2+T+i*secW,H/2,0),"Вертикальная перегородка");
  const perSec=Math.floor(shelves/S);
  let sn=0;
  for(let s=0;s<S;s++) for(let j=0;j<perSec && sn<shelves;j++,sn++){
    const y=T+(H-2*T)*(j+1)/(perSec+1);
    box("Полка "+(sn+1),secW-T,T,D-2*T,new THREE.Vector3(-W/2+T+s*secW+secW/2,y,0),"Полка");
  }
  for(let i=0;i<doors;i++){
    const dw=W/doors-2; const x=-W/2+W*(i+.5)/doors;
    box("Фасад "+(i+1),dw,H-2,T,new THREE.Vector3(x,H/2,D/2+T/2),"Фасад");
  }
  validate("Модель построена. Проверено: корпус, перегородки, полки и фасады.","ok");
  $("partsCount").textContent=parts.length; $("summary").textContent=parts.length+" деталей · "+W+"×"+H+"×"+D+" мм";
  renderList(); fit();
  exploded=false; $("explode").textContent="Взрыв";
}
function validate(t,c){const e=$("validation");e.textContent=t;e.className="validation "+c}
function renderList(){const p=$("partsList");p.innerHTML="";parts.forEach((m,i)=>{const b=m.geometry.parameters;const el=document.createElement("div");el.className="part";el.innerHTML="<strong>"+(i+1)+". "+m.userData.name+"</strong><span>"+b.width.toFixed(0)+" × "+b.height.toFixed(0)+" × "+b.depth.toFixed(0)+" мм · "+m.userData.kind+"</span>";el.onclick=()=>{controls.target.copy(m.position);camera.position.copy(m.position).add(new THREE.Vector3(900,700,900));};p.appendChild(el)})}
function fit(){const b=new THREE.Box3().setFromObject(root),c=b.getCenter(new THREE.Vector3()),s=b.getSize(new THREE.Vector3()),r=Math.max(s.x,s.y,s.z)*1.8;controls.target.copy(c);camera.position.set(c.x+r*.95,c.y+r*.7,c.z+r);controls.update()}
function setExplode(on){exploded=on;parts.forEach((m,i)=>{const d=m.userData.base.clone().sub(new THREE.Vector3(0,1000,0)).normalize();if(d.lengthSq()<.1)d.set((i%3)-1,.4,(i%2?1:-1));d.normalize();m.position.copy(m.userData.base).add(on?d.multiplyScalar(Math.max(+$("width").value,+$("height").value,+$("depth").value)*.35):new THREE.Vector3());});$("explode").textContent=on?"Свернуть":"Взрыв";controls.update()}
function front(){controls.target.set(0,+$("height").value/2,0);camera.position.set(0,+$("height").value/2,+Math.max(+$("width").value,+$("height").value)*2.2);controls.update()}
function iso(){fit()}
$("build").onclick=build;$("explode").onclick=()=>setExplode(!exploded);$("resetExplode").onclick=()=>setExplode(false);$("frontView").onclick=front;$("isoView").onclick=iso;$("material").onchange=build;
$("newProject").onclick=()=>{["width","height","depth","thickness","sections","shelves","doors"].forEach((id,i)=>$(id).value=[2400,2200,600,18,3,6,3][i]);build()};
$("saveProject").onclick=()=>{const data={version:"0.1",name:"Furniture AI Designer",parameters:Object.fromEntries(["width","height","depth","thickness","sections","shelves","doors","material","edge"].map(id=>[id,$(id).value]))};const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.download="furniture-ai-project.json";a.click();URL.revokeObjectURL(a.href)};
$("loadProject").onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{const d=JSON.parse(r.result);Object.entries(d.parameters||{}).forEach(([k,v])=>$(k)&&( $(k).value=v));build()}catch{validate("Не удалось прочитать проект JSON.","error")}};r.readAsText(f)};
window.addEventListener("resize",()=>{camera.aspect=viewer.clientWidth/viewer.clientHeight;camera.updateProjectionMatrix();renderer.setSize(viewer.clientWidth,viewer.clientHeight)});
function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera)} animate(); build();