import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, BarChart, Bar, ReferenceLine,
  Legend, Scatter, ScatterChart
} from 'recharts';

// ── Colores ────────────────────────────────────────────────────────
const C = {
  // Paleta Sensara
  green:"#5a9e2f",      // verde oscuro Sensara — SicAir, datos normales
  greenLight:"#7ab830", // verde medio Sensara — acentos
  greenFade:"rgba(90,158,47,0.08)",
  lime:"#a8c820",       // verde lima Sensara — secundario
  limeFade:"rgba(168,200,32,0.08)",
  // Alertas
  amber:"#d97706",      amberFade:"rgba(217,119,6,0.08)",
  red:"#dc2626",        redFade:"rgba(220,38,38,0.08)",
  // Neutros
  blue:"#2563eb",       blueFade:"rgba(37,99,235,0.08)",
  purple:"#7c3aed",
  text:"#1a1a1a", muted:"#6b7280", bg:"#f8f9fa",
  panel:"#ffffff", border:"#f0f0f0", gridLine:"#f5f5f5",
};

// ── Umbrales calibrados con histórico real Rubí 2025-09-25 / 2026-06-19 ─
const DEFAULTS = {
  rs_min:      10,
  inh_aviso:   60,
  inh_critico: 50,
  aur_bajo:    1.96,   // P10 AUR válidos Rubí (2765 tests)
  aur_ref:     3.61,   // Media AUR válidos Rubí
  kw_soplante: 7.5,
  eur_kwh:     0.15,
};

// ── Alertas por defecto ────────────────────────────────────────────
const ALERT_DEF = [
  {id:"aur_bajo",    label:"AUR mínimo",          icon:"🔬", unit:"mgO₂/gSSV·h", campo:"AUR",    tipo:"min", valor:0.8,  activa:true,  sonido:true,  severidad:"critica"},
  {id:"inh_aviso",   label:"INH alerta (>60%)",   icon:"☣️", unit:"%",           campo:"INH",    tipo:"max", valor:60,   activa:true,  sonido:false, severidad:"aviso"},
  {id:"inh_critico", label:"INH crítico (>50%)",  icon:"☣️", unit:"%",           campo:"INH",    tipo:"max", valor:50,   activa:true,  sonido:true,  severidad:"critica"},
  {id:"vertido",     label:"Vertido confirmado",  icon:"🚨", unit:"(INH+AUR)",   campo:"vertido",tipo:"max", valor:0,    activa:true,  sonido:true,  severidad:"critica"},
];
const TIPOS_INC = [
  {id:"vertido", label:"☣️ Vertido tóxico", color:C.red},
  {id:"parada",  label:"🛑 Parada",          color:C.amber},
  {id:"averia",  label:"🔧 Avería",          color:C.amber},
  {id:"carga",   label:"📥 Cambio carga",    color:C.blue},
  {id:"otro",    label:"📝 Otro",            color:C.muted},
];

// ── Logo ───────────────────────────────────────────────────────────
const SensaraLogo = ({size=36}) => (
  <svg width={size*1.5} height={size} viewBox="0 0 120 80" fill="none">
    <polygon points="30,4 58,4 72,28 58,52 30,52 16,28" fill="#c8e000" opacity="0.85"/>
    <polygon points="50,4 78,4 92,28 78,52 50,52 36,28" fill="#4a9c3f" opacity="0.85"/>
    <polygon points="40,28 68,28 82,52 68,76 40,76 26,52" fill="#6dba5f" opacity="0.75"/>
    <text x="16" y="44" fontFamily="system-ui" fontWeight="700" fontSize="18" fill="white">sensara</text>
  </svg>
);

// ── Parsers ────────────────────────────────────────────────────────
function parseNum(s) {
  if (s==null||String(s).trim()==="") return null;
  const n = parseFloat(String(s).trim().replace(",","."));
  return isNaN(n)?null:n;
}
function parseDate(fecha, hora) {
  if (!fecha||!hora) return null;
  const f=fecha.trim();
  if (f.includes("/")) {
    const [d,m,y]=f.split("/");
    if (!d||!m||!y) return null;
    return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T${hora.trim()}`);
  }
  return new Date(`${f}T${hora.trim()}`);
}
function buildRows(records, cfg) {
  const rows=[];
  for (const v of records) {
    const rs1=parseNum(v["Rs Max 1"]), rs2=parseNum(v["Rs Max 2"]);
    const inh=parseNum(v["INH"]),      aur=parseNum(v["AUR"]);
    const fecha=String(v["Fecha"]||"").trim(), hora=String(v["Hora"]||"").trim();
    if (inh==null||fecha===""||hora==="") continue;  // AUR puede ser null (versiones antiguas SN8)
    const dt=parseDate(fecha,hora);
    if (!dt||isNaN(dt)) continue;
    const oxVal=parseNum(v["ox_max_v1"])??0;
    const oxOk=oxVal<0.01||oxVal>=2; // 0 o null = sin datos ox (registros históricos o sync viejo)
    const completo=(aur!=null&&aur>0&&rs1!=null&&rs1>0); // test terminado
    const valido=oxOk&&completo;
    rows.push({
      id: v["id"]??null,
      AUR:aur, INH:inh??0,
      RS1:rs1??0, RS2:rs2??0, valido, completo,
      RN:parseNum(v["RN"])??0,
      ox_max_v1: parseNum(v["ox_max_v1"])??0,
      datetime:dt, diaSemana:dt.getDay(),
      label:`${fecha.slice(0,10)} ${hora.slice(0,5)}`,
    });
  }
  return rows.sort((a,b)=>a.datetime-b.datetime);
}
function parseCSV(raw, cfg) {
  // Normaliza saltos de línea y BOM
  const cleaned = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleaned.split("\n");
  const sep = lines.find(l=>l.includes(";")) ? ";" : lines.find(l=>l.includes("\t")) ? "\t" : ",";

  // Detecta si es multi-tabla SN8 (tiene sección TOXICIDAD)
  const toxIdx = lines.findIndex(l => l.toUpperCase().includes("TOXICIDAD"));
  if (toxIdx >= 0) {
    // Busca la línea de cabecera de TOXICIDAD (la que tiene INH)
    let hdrIdx = -1;
    for (let i = toxIdx; i < Math.min(toxIdx + 5, lines.length); i++) {
      if (lines[i].toUpperCase().includes("INH") && lines[i].toUpperCase().includes("AUR")) {
        hdrIdx = i; break;
      }
    }
    if (hdrIdx < 0) { alert("No se encontró cabecera de TOXICIDAD en el CSV."); return []; }
    const hdrRaw = lines[hdrIdx].split(sep).map(h => h.trim());
    const hdrOffset = hdrRaw[0] === "" ? 1 : 0;
    const hdr = hdrRaw.slice(hdrOffset);
    const records = [];
    // Find next section start (another BIOLOGICO header after toxicity)
    let endIdx = lines.length;
    for (let i = hdrIdx + 1; i < lines.length; i++) {
      const lu = lines[i].toUpperCase();
      if ((lu.includes("BIOLOGICO") || lu.includes("NITRIF") || lu.includes("DESNI") || lu.includes("DQOB") || lu.includes("OUR;")) && !lu.includes("TOXICIDAD")) {
        endIdx = i; break;
      }
    }
    for (let i = hdrIdx + 1; i < endIdx; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      const valsRaw = lines[i].split(sep);
      const vals = valsRaw.slice(hdrOffset);
      if (vals.length < 4) continue;
      const obj = {};
      hdr.forEach((h, j) => obj[h] = vals[j]?.trim() ?? "");
      records.push(obj);
    }
    if (!records.length) { alert("Sin datos en la sección TOXICIDAD del CSV."); return []; }
    return buildRows(records, cfg);
  }

  // CSV simple de una sola tabla
  const hdr = lines[0].split(sep).map(h => h.trim());
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(sep);
    const obj = {};
    hdr.forEach((h, j) => obj[h] = vals[j]?.trim());
    records.push(obj);
  }
  return buildRows(records, cfg);
}
async function parseXLSX(buffer, cfg) {
  const XLSX=window.XLSX;
  if(!XLSX) throw new Error("XLSX no disponible");
  const wb=XLSX.read(buffer,{type:"array"});
  const ws=wb.Sheets[wb.SheetNames[0]];
  return buildRows(XLSX.utils.sheet_to_json(ws,{raw:false,defval:""}), cfg);
}

// ── Modelos (pendiente calibración con histórico real Rubí) ──────
const MODEL_AUR = {
  feats:     ['aur_prev1','aur_roll3','aur_roll6','aur_trend','inh_roll6','inh_prev1','hour','dow','month'],
  coefs:     [-0.5342, 1.3719, 0.289, 0.7608, 0.0198, -0.0359, -0.0232, -0.0064, -0.01],
  intercept: 3.6058,
  means:     [3.6061, 3.6066, 3.6078, -0.0013, 8.6879, 8.7003, 16.4723, 3.1859, 7.4335],
  stds:      [1.2793, 1.1986, 1.1449,  0.9604, 12.6012, 17.2825, 4.0398, 1.9537, 4.0267],
  mape: 6.6, r2: 0.946,
};
const MODEL_TOX = {
  feats:     ['inh_roll6','inh_trend','inh_roll3','inh_prev1','hour','month','dow'],
  coefs:     [0.2791, 0.2335, 0.2719, 0.1752, -0.0926, -0.0963, -0.0214],
  intercept: -1.5524,
  means:     [8.6772, -0.0036, 8.7041, 8.7034, 16.471, 7.434, 3.1856],
  stds:      [12.591, 18.9309, 14.0776, 17.2849, 4.0399, 4.0274, 1.954],
  auc: 0.800,
};

function applyLinear(model, vals) {
  let s = model.intercept;
  vals.forEach((v,j) => s += model.coefs[j] * (v - model.means[j]) / model.stds[j]);
  return s;
}
function sigmoid(x) { return 1/(1+Math.exp(-x)); }

function predecirAUR(data) {
  if (!data||data.length<5) return null;
  const valid=data.filter(d=>d.valido&&d.completo&&d.AUR!=null&&d.AUR>0);
  if (valid.length<5) return null;
  const last=valid.at(-1);
  const n=valid.length;

  // AUR rolling features
  const aur_prev1 = valid.at(-2)?.AUR ?? last.AUR;
  const aur_roll3 = valid.slice(-3).reduce((s,d)=>s+d.AUR,0)/Math.min(3,n);
  const aur_roll6 = valid.slice(-6).reduce((s,d)=>s+d.AUR,0)/Math.min(6,n);
  const aur_trend = n>=4 ? last.AUR - valid.at(-4).AUR : 0;
  const inh_roll6 = valid.slice(-6).reduce((s,d)=>s+d.INH,0)/Math.min(6,n);
  const inh_prev1 = valid.at(-2)?.INH ?? 0;
  const hour=last.datetime.getHours(), dow=last.datetime.getDay(), month=last.datetime.getMonth()+1;

  const aur_pred_raw = applyLinear(MODEL_AUR, [aur_prev1,aur_roll3,aur_roll6,aur_trend,inh_roll6,inh_prev1,hour,dow,month]);
  const aur_pred = +Math.max(0.1, Math.min(10, aur_pred_raw)).toFixed(3);

  // INH rolling features for tox model
  const allValid=data.filter(d=>d.valido);
  const nT=allValid.length;
  const inh_roll6T = allValid.slice(-6).reduce((s,d)=>s+d.INH,0)/Math.min(6,nT);
  const inh_roll3T = allValid.slice(-3).reduce((s,d)=>s+d.INH,0)/Math.min(3,nT);
  const inh_prev1T = allValid.at(-2)?.INH ?? 0;
  const inh_trend  = nT>=4 ? allValid.at(-1).INH - allValid.at(-4).INH : 0;
  const tox_prob   = sigmoid(applyLinear(MODEL_TOX, [inh_roll6T,inh_trend,inh_roll3T,inh_prev1T,hour,month,dow]));

  const aur_media  = +(valid.slice(-20).reduce((s,d)=>s+d.AUR,0)/Math.min(20,n)).toFixed(3);
  const mins_pred  = Math.round(Math.max(25, Math.min(160, aur_pred*35)));
  const mins_actual= Math.round(Math.max(25, Math.min(160, aur_media*35)));

  return {
    aur_pred, aur_media, mins_pred, mins_actual,
    tox_prob: +tox_prob.toFixed(3),
    tox_score: Math.round(tox_prob*100),
    aur_prev1: +aur_prev1.toFixed(3),
    aur_roll6: +aur_roll6.toFixed(3),
    inh_roll6: +inh_roll6T.toFixed(1),
    inh_trend: +inh_trend.toFixed(1),
  };
}

// ── Demo data ─────────────────────────────────────────────────────
function generarDemoData() {
  const rows=[], now=new Date();
  for (let i=299;i>=0;i--) {
    const dt=new Date(now.getTime()-i*95*60000);
    const hora=dt.getHours(), dow=dt.getDay();
    const base=2.0+1.2*Math.sin((hora-8)*Math.PI/12);
    let aur=Math.max(0.2,Math.min(6,base+(Math.random()-0.5)*0.3));
    let inh=Math.max(0,(Math.random()-0.75)*12);
    if (dow===5&&hora>=8&&hora<=20&&Math.random()<0.3) {
      inh=20+Math.random()*60; if(inh>20) aur*=0.55;
    }
    const rs1=inh>50?5+Math.random()*4:12+Math.random()*20;
    const rs2=inh>50?5+Math.random()*4:12+Math.random()*20;
    rows.push({
      AUR:+aur.toFixed(3),INH:+inh.toFixed(1),
      RS1:+rs1.toFixed(1),RS2:+rs2.toFixed(1),
      ox_max_v1: 6.0 + Math.random()*2,
      valido:rs1>10,
      RN:+(aur*0.3+Math.random()*0.1).toFixed(3),
      datetime:dt, diaSemana:dow,
      label:`${dt.toLocaleDateString("es-ES")} ${dt.toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}`,
    });
  }
  return rows;
}

// ── Helpers ───────────────────────────────────────────────────────
function linReg(pts) {
  const n=pts.length; if(n<2) return {m:0,b:0,r2:0};
  const sx=pts.reduce((s,p)=>s+p.x,0),sy=pts.reduce((s,p)=>s+p.y,0);
  const sxx=pts.reduce((s,p)=>s+p.x**2,0),sxy=pts.reduce((s,p)=>s+p.x*p.y,0);
  const m=(n*sxy-sx*sy)/(n*sxx-sx**2)||0,b=(sy-m*sx)/n;
  const yM=sy/n,ssT=pts.reduce((s,p)=>s+(p.y-yM)**2,0),ssR=pts.reduce((s,p)=>s+(p.y-(m*p.x+b))**2,0);
  return {m:+m.toFixed(4),b:+b.toFixed(4),r2:ssT?+(1-ssR/ssT).toFixed(3):0};
}
function playAlertTone(type="warning") {
  try {
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const freqs=type==="critical"?[880,660,880,660]:[660,880];
    let t=ctx.currentTime;
    freqs.forEach(f=>{
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.connect(g);g.connect(ctx.destination);
      o.frequency.value=f;o.type="sine";
      g.gain.setValueAtTime(0.3,t);g.gain.exponentialRampToValueAtTime(0.001,t+0.2);
      o.start(t);o.stop(t+0.2);t+=0.25;
    });
    setTimeout(()=>ctx.close(),2000);
  } catch {}
}
function clasificarTest(row,cfg) {
  if(!row.valido) return "invalido";
  const inhAlta=row.INH>=cfg.inh_aviso, inhCrit=row.INH>=cfg.inh_critico;
  const aurBaja=row.AUR!=null&&row.AUR<cfg.aur_bajo;
  if(inhCrit&&aurBaja) return "critico";
  if(inhCrit) return "inh_critico";
  if(inhAlta&&aurBaja) return "vertido_conf";
  if(inhAlta) return "inh_aviso";
  if(aurBaja) return "aur_bajo";
  return "normal";
}
const ESTADO_COLOR={normal:C.green,aur_bajo:C.blue,inh_aviso:C.amber,vertido_conf:C.purple,inh_critico:C.red,critico:C.red,invalido:"#ccc"};
const ESTADO_LABEL={normal:"Normal",aur_bajo:"AUR baja",inh_aviso:"INH alerta",vertido_conf:"Vertido confirmado",inh_critico:"INH crítico",critico:"CRÍTICO",invalido:"Inválido"};

function evaluarAlertas(alertas,data,cfg) {
  if(!data?.length||!alertas.length) return [];
  const valid=data.filter(d=>d.valido);
  if(!valid.length) return [];
  const last=valid.at(-1);
  const vertido=(last.INH>=cfg.inh_aviso&&last.AUR!=null&&last.AUR<cfg.aur_bajo)?1:0;
  const vals={AUR:last.AUR??0,INH:last.INH,vertido};
  return alertas.filter(a=>a.activa).map(a=>{
    const v=vals[a.campo]; if(v==null) return null;
    const dispara=(a.tipo==="min"&&v<a.valor)||(a.tipo==="max"&&v>a.valor);
    return dispara?{...a,valorActual:+v.toFixed(2)}:null;
  }).filter(Boolean);
}

// ── UI primitives ─────────────────────────────────────────────────
function Badge({children,color}){
  return <span style={{background:color+"15",color,borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:600}}>{children}</span>;
}
function KpiCard({label,value,unit,color,icon,sub}){
  return(
    <div style={{background:"#fff",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)",border:"1px solid #f0f0f0"}}>
      <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,fontWeight:500}}>{icon} {label}</div>
      <div style={{fontSize:26,fontWeight:700,color,lineHeight:1,marginBottom:4,fontFamily:"monospace"}}>{value}</div>
      <div style={{fontSize:11,color:C.muted}}>{unit}</div>
      {sub&&<div style={{fontSize:10,color:C.muted,marginTop:4}}>{sub}</div>}
    </div>
  );
}
function CT({active,payload,label}){
  if(!active||!payload?.length) return null;
  return(
    <div style={{background:"#fff",border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",fontSize:12,boxShadow:"0 4px 20px rgba(0,0,0,0.10)"}}>
      <div style={{color:C.muted,marginBottom:6,fontSize:11}}>{label}</div>
      {payload.map((p,i)=>p.value!=null&&(
        <div key={i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:2}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:p.color,display:"inline-block"}}/>
          <span style={{color:C.muted}}>{p.name}:</span>
          <span style={{fontWeight:600}}>{typeof p.value==="number"?p.value.toFixed(2):p.value}</span>
        </div>
      ))}
    </div>
  );
}
function AlertaBanner({alertas,onDismiss}){
  if(!alertas.length) return null;
  const esCrit=alertas.some(a=>a.severidad==="critica");
  return(
    <div style={{position:"sticky",top:0,zIndex:200,background:esCrit?C.red:C.amber,color:"#fff",padding:"10px 32px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <span style={{fontWeight:800,fontSize:13}}>🔔 {alertas.length} alerta{alertas.length>1?"s":""}</span>
      {alertas.map(a=>(
        <span key={a.id} style={{background:"rgba(255,255,255,0.2)",borderRadius:20,padding:"2px 10px",fontSize:12,fontWeight:600}}>
          {a.icon} {a.label}: {a.valorActual} {a.unit}
          <button onClick={()=>onDismiss(a.id)} style={{background:"none",border:"none",color:"#fff",cursor:"pointer",marginLeft:6,fontSize:13}}>✕</button>
        </span>
      ))}
    </div>
  );
}
function DropZone({onFile,onBinary,accept,label,sublabel,color,done}){
  const [drag,setDrag]=useState(false);
  const ref=useRef();
  const handle=useCallback(file=>{
    if(!file) return;
    if(file.name?.match(/\.xlsx?$/i)&&onBinary){const r=new FileReader();r.onload=e=>onBinary(e.target.result);r.readAsArrayBuffer(file);}
    else{const r=new FileReader();r.onload=e=>onFile(e.target.result);r.readAsText(file);}
  },[onFile,onBinary]);
  return(
    <div onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)}
      onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files[0])}} onClick={()=>ref.current.click()}
      style={{border:`2px dashed ${done?color:drag?color:C.border}`,borderRadius:10,background:done?color+"08":drag?color+"10":"#fafafa",padding:"16px",textAlign:"center",cursor:"pointer",transition:"all .2s"}}>
      <input ref={ref} type="file" accept={accept} style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
      <div style={{fontSize:18,marginBottom:4}}>{done?"✅":"📂"}</div>
      <div style={{fontSize:11,fontWeight:700,color:done?color:C.text,marginBottom:2}}>{label}</div>
      <div style={{fontSize:10,color:C.muted}}>{sublabel}</div>
    </div>
  );
}

// ── Semáforo ──────────────────────────────────────────────────────
function Semaforo({data,alertasDisp,cfg}){
  if(!data?.length) return null;
  const valid=data.filter(d=>d.valido);
  if(!valid.length) return null;
  const lastComplete=valid.filter(d=>d.completo);
  const last=lastComplete.at(-1)??valid.at(-1);
  const estado=clasificarTest(last,cfg);
  const esCrit=["critico","inh_critico","vertido_conf"].includes(estado);
  const esAviso=["inh_aviso","aur_bajo"].includes(estado);
  const col=esCrit?C.red:esAviso?C.amber:C.green;
  const msgs={
    critico:"🚨 VERTIDO CRÍTICO — INH alta + AUR colapsada",
    vertido_conf:"⚠️ VERTIDO CONFIRMADO — INH>20% + AUR baja",
    inh_critico:"☣️ INHIBICIÓN CRÍTICA >50%",
    inh_aviso:"⚠️ Inhibición elevada >60%",
    aur_bajo:"🔵 AUR baja — revisar fango",
    normal:"✅ Sistema operando correctamente",
    invalido:"⚠️ Último test inválido (O₂ inicial bajo — aireación deficiente)",
  };
  return(
    <div style={{background:"#fff",borderRadius:16,padding:"16px 24px",display:"flex",alignItems:"center",gap:20,marginBottom:20,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",border:`2px solid ${col}25`}}>
      <div style={{width:14,height:14,borderRadius:"50%",background:col,boxShadow:`0 0 0 5px ${col}25`,flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{fontSize:14,fontWeight:700,color:col,marginBottom:6}}>{msgs[estado]||msgs.normal}</div>
        <div style={{display:"flex",gap:20,fontSize:12,color:C.muted,flexWrap:"wrap"}}>
          <span>AUR <b style={{color:C.text,fontFamily:"monospace"}}>{last.AUR!=null?last.AUR.toFixed(2):"—"}</b> mgO₂/gSSV·h</span>
          <span>INH <b style={{color:last.INH>=cfg.inh_critico?C.red:last.INH>=cfg.inh_aviso?C.amber:C.text,fontFamily:"monospace"}}>{last.INH.toFixed(1)}%</b></span>
          <span>Rs <b style={{color:last.valido?C.text:C.red,fontFamily:"monospace"}}>{last.RS1?.toFixed(1)??'—'}/{last.RS2?.toFixed(1)??'—'}</b></span>
          <span>Test <b style={{color:last.valido?C.green:C.red}}>{last.valido?"válido":"inválido"}</b></span>
        </div>
      </div>
      <Badge color={col}>{ESTADO_LABEL[estado]}</Badge>
    </div>
  );
}

// ── KPIs ──────────────────────────────────────────────────────────
function KpisPanel({data,pred,cfg}){
  if(!data?.length) return null;
  const valid=data.filter(d=>d.valido);
  if(!valid.length) return null;
  const lastComplete=valid.filter(d=>d.completo);
  const last=lastComplete.at(-1)??valid.at(-1);
  const pct20=+(100*valid.filter(d=>d.INH>=cfg.inh_aviso).length/valid.length).toFixed(1);
  const toxScore=pred?.tox_score??null;
  const toxCol=toxScore!=null?(toxScore>=70?C.red:toxScore>=40?C.amber:C.green):C.muted;
  const labelStyle={fontSize:9,fontWeight:800,letterSpacing:"0.08em",textTransform:"uppercase",
    padding:"2px 8px",borderRadius:4,marginBottom:8,display:"inline-block"};
  return(
    <div style={{marginBottom:20,display:"grid",gap:10}}>
      <div>
        <div style={{...labelStyle,background:C.limeFade,color:C.green}}>⚡ SicAir — Control de aireación</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          <KpiCard icon="🔬" label="AUR actual"     value={last.AUR!=null?last.AUR.toFixed(2):"—"} unit="mgO₂/gSSV·h" color={last.AUR!=null&&last.AUR<cfg.aur_bajo?C.red:C.green}/>
          <KpiCard icon="🔮" label="AUR pred. +1c"  value={pred?.aur_pred?.toFixed(2)??"—"} unit="mgO₂/gSSV·h" color={C.lime} sub={pred?`→ ${pred.mins_pred} min recomendados`:""}/>
          <KpiCard icon="⏱️" label="Tiempo actual soplante" value={pred?.mins_actual??"—"} unit="min/ciclo (referencia)" color={C.lime}/>
        </div>
      </div>
      <div>
        <div style={{...labelStyle,background:C.redFade,color:C.red}}>☣️ SicTox — Control de toxicidad</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          <KpiCard icon="☣️" label="INH actual"     value={`${last.INH.toFixed(1)}%`} unit={last.INH>=cfg.inh_critico?"⚠️ crítico":last.INH>=cfg.inh_aviso?"⚠️ alerta":"normal"} color={last.INH>=cfg.inh_critico?C.red:last.INH>=cfg.inh_aviso?C.amber:C.green}/>
          <KpiCard icon="🎯" label="Riesgo vertido" value={toxScore!=null?`${toxScore}/100`:"—"} unit={toxScore!=null?(toxScore>=70?"ALTO":toxScore>=40?"MEDIO":"BAJO"):"modelo"} color={toxCol}/>
          <KpiCard icon="📊" label="INH>20% hist."  value={`${pct20}%`} unit={`${valid.length} tests válidos`} color={pct20>15?C.red:pct20>8?C.amber:C.green}/>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Predicción SicAir ────────────────────────────────────────
function PredPanel({data,pred,cfg}){
  if(!data?.length||!pred) return(
    <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"32px",textAlign:"center",color:C.muted,marginBottom:14}}>
      <div style={{fontSize:32,marginBottom:12}}>🔮</div>
      <div style={{fontSize:14,fontWeight:600}}>Sin datos suficientes para predecir</div>
      <div style={{fontSize:12,marginTop:8}}>Carga el CSV del SN8 con al menos 10 tests válidos</div>
    </div>
  );
  const validAUR=data.filter(d=>d.valido&&d.AUR!=null).slice(-60);
  const hist=validAUR.map((d,i)=>({label:d.label,aur:d.AUR,idx:i}));
  const reg=linReg(hist.map(d=>({x:d.idx,y:d.aur})));
  const histR=hist.map((d,i)=>({...d,tendencia:+(reg.m*i+reg.b).toFixed(3)}));
  const last=hist.at(-1);
  const predPts=last?[
    {label:last.label,aur:last.aur},
    {label:"+1c",aurPred:pred.aur_pred},
    {label:"+3c",aurPred:+(pred.aur_pred*0.97).toFixed(3)},
    {label:"+6h",aurPred:+(pred.aur_pred*0.93).toFixed(3)},
  ]:[];
  const combined=[...histR,...predPts.slice(1)];
  const ahorro=pred.mins_actual-pred.mins_pred;
  const kwhAhorro=+(ahorro/60*cfg.kw_soplante).toFixed(1);
  const eurAhorro=+(kwhAhorro*cfg.eur_kwh).toFixed(2);
  return(
    <div style={{marginBottom:14}}>
      {/* Badges modelo */}
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <Badge color={C.lime}>🔬 Modelo AUR · Ridge · MAPE {MODEL_AUR.mape}% · R²={MODEL_AUR.r2}</Badge>
        <Badge color={C.lime}>📊 Calibrado Rubí 2025–2026 · {data.filter(d=>d.valido).length} tests</Badge>
      </div>
      {/* Predicción AUR */}
      <div style={{marginBottom:14}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {[
            {label:"+1 ciclo (~95 min)",aurP:pred.aur_pred,            minsP:pred.mins_pred},
            {label:"+3 ciclos (~5h)",   aurP:+(pred.aur_pred*0.97).toFixed(3),minsP:Math.round(pred.mins_pred*0.97)},
            {label:"+6 horas",          aurP:+(pred.aur_pred*0.93).toFixed(3),minsP:Math.round(pred.mins_pred*0.93)},
          ].map(({label,aurP,minsP})=>(
            <div key={label} style={{background:"#fff",border:`1.5px solid ${C.border}`,borderRadius:10,padding:"14px 16px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
              <div style={{fontSize:11,fontWeight:600,color:C.muted,marginBottom:8}}>{label}</div>
              <div style={{marginBottom:8}}>
                <div style={{fontSize:10,color:C.muted}}>AUR pred.</div>
                <div style={{fontSize:22,fontWeight:800,color:C.green,fontFamily:"monospace"}}>{aurP?.toFixed(2)??"—"}</div>
                <div style={{fontSize:10,color:C.muted}}>mgO₂/gSSV·h</div>
              </div>
              <div>
                <div style={{fontSize:10,color:C.muted}}>Min aireación</div>
                <div style={{fontSize:22,fontWeight:800,color:C.amber,fontFamily:"monospace"}}>{minsP}</div>
                <div style={{fontSize:10,color:C.muted}}>min/ciclo</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Ahorro estimado */}
      <div style={{background:ahorro>0?"#f0fdf4":C.amberFade,border:`2px solid ${ahorro>0?C.green:C.amber}`,borderRadius:12,padding:"18px 24px",marginBottom:14,display:"flex",alignItems:"center",gap:32,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>💰 Ahorro estimado/ciclo</div>
          <div style={{fontSize:36,fontWeight:900,color:ahorro>0?C.green:C.amber,fontFamily:"monospace"}}>{ahorro>0?"+":""}{ahorro} min</div>
          <div style={{fontSize:12,color:C.muted}}>vs. tiempo actual de soplante</div>
        </div>
        <div style={{display:"flex",gap:24,flexWrap:"wrap"}}>
          {[
            {l:"kWh/ciclo",    v:Math.abs(kwhAhorro),  c:C.blue},
            {l:"€/ciclo",     v:`${Math.abs(eurAhorro)}€`, c:C.green},
            {l:"€/día (~15c)",v:`${+(Math.abs(eurAhorro)*15).toFixed(1)}€`,c:C.green},
            {l:"€/año",       v:`${Math.round(Math.abs(eurAhorro)*15*365).toLocaleString()}€`,c:C.green},
          ].map(({l,v,c})=>(
            <div key={l} style={{textAlign:"center"}}>
              <div style={{fontSize:10,color:C.muted}}>{l}</div>
              <div style={{fontSize:20,fontWeight:800,color:c,fontFamily:"monospace"}}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{fontSize:11,color:C.muted,maxWidth:180,lineHeight:1.6}}>
          Estimación basada en {cfg.kw_soplante} kW/soplante · {cfg.eur_kwh}€/kWh · 15 ciclos/día
        </div>
      </div>
      {/* Gráfica AUR + pred */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:13,fontWeight:700}}>📈 Histórico AUR + Predicción SicAir</div>
          <Badge color={reg.m>0?C.amber:C.green}>Tendencia {reg.m>0?"↑":"↓"} R²={reg.r2}</Badge>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={combined} margin={{top:4,right:8,bottom:4,left:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
            <XAxis dataKey="label" tick={{fontSize:8,fill:C.muted}} interval={Math.floor(combined.length/8)} angle={-20} textAnchor="end" height={36}/>
            <YAxis domain={[0,"auto"]} tick={{fontSize:9,fill:C.muted}}/>
            <Tooltip content={<CT/>}/>
            <ReferenceLine y={cfg.aur_bajo} stroke={C.red}   strokeDasharray="4 2" label={{value:`AUR bajo (${cfg.aur_bajo})`,fill:C.red,fontSize:9}}/>
            <ReferenceLine y={cfg.aur_ref}  stroke={C.green} strokeDasharray="4 2" label={{value:`AUR ref (${cfg.aur_ref})`,fill:C.green,fontSize:9}}/>
            <Area dataKey="aur"     fill={C.greenFade} stroke={C.green} strokeWidth={2}  dot={false} name="AUR real" connectNulls/>
            <Line dataKey="tendencia" stroke={C.amber} strokeWidth={1} dot={false} strokeDasharray="3 3" name="Tendencia" connectNulls/>
            <Line dataKey="aurPred"  stroke={C.green} strokeWidth={2} strokeDasharray="6 3" dot={{r:5,fill:C.green,stroke:"#fff",strokeWidth:2}} name="AUR pred." connectNulls/>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Tab: Histórico AUR + INH ──────────────────────────────────────
function HistoricoPanel({data,cfg}){
  if(!data?.length) return null;
  const valid=data.filter(d=>d.valido);

  const porDia={};
  valid.forEach(d=>{
    const k=d.datetime.toISOString().slice(0,10);
    if(!porDia[k]) porDia[k]={fecha:k,aurSuma:0,aurN:0};
    if(d.AUR!=null){porDia[k].aurSuma+=d.AUR;porDia[k].aurN++;}
  });
  const hist=Object.values(porDia).map(d=>({
    fecha:d.fecha,
    aur:d.aurN>0?+(d.aurSuma/d.aurN).toFixed(3):null,
  })).sort((a,b)=>a.fecha.localeCompare(b.fecha));

  const regPts=hist.filter(d=>d.aur!=null).map((d,i)=>({x:i,y:d.aur}));
  const reg=linReg(regPts);
  const histR=hist.map((d,i)=>({...d,tendencia:d.aur!=null?+(reg.m*i+reg.b).toFixed(3):null}));
  return(
    <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <div style={{fontSize:13,fontWeight:700}}>📈 Histórico AUR — media diaria · datos válidos (O₂ inicial ≥ 2)</div>
        <Badge color={reg.m>0?C.amber:C.green}>Tendencia AUR {reg.m>0?"↑":"↓"} R²={reg.r2}</Badge>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={histR} margin={{top:4,right:8,bottom:4,left:0}}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
          <XAxis dataKey="fecha" tick={{fontSize:8,fill:C.muted}} interval={Math.floor(histR.length/10)} angle={-20} textAnchor="end" height={36}/>
          <YAxis domain={[0,"auto"]} tick={{fontSize:9,fill:C.muted}}/>
          <Tooltip content={<CT/>}/>
          <ReferenceLine y={cfg.aur_bajo} stroke={C.red}   strokeDasharray="4 2" label={{value:"AUR bajo",fill:C.red,fontSize:9}}/>
          <ReferenceLine y={cfg.aur_ref}  stroke={C.green} strokeDasharray="4 2" label={{value:"AUR ref.",fill:C.green,fontSize:9}}/>
          <Area dataKey="aur"       fill={C.greenFade} stroke={C.green} strokeWidth={1.5} dot={false} name="AUR" connectNulls/>
          <Line dataKey="tendencia" stroke={C.amber}   strokeWidth={1}  dot={false} strokeDasharray="3 3" name="Tendencia" connectNulls/>
        </ComposedChart>
      </ResponsiveContainer>

      {/* Tabla de tests recientes */}
      <div style={{marginTop:18}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>📋 Todos los tests válidos — más reciente primero</div>
        <div style={{overflowX:"auto",maxHeight:400,overflowY:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead style={{position:"sticky",top:0,background:"#fff",zIndex:1}}>
              <tr style={{borderBottom:`2px solid ${C.border}`}}>
                {["Fecha","Hora","AUR","Rs Max 1","Rs Max 2","RN"].map(h=>(
                  <th key={h} style={{padding:"8px 10px",fontSize:10,color:C.muted,textTransform:"uppercase",fontWeight:700,textAlign:"left"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...valid].reverse().map((d,i)=>{
                const aurBaja = d.AUR!=null && d.AUR < cfg.aur_bajo;
                return(
                  <tr key={i} style={{borderBottom:`1px solid ${C.gridLine}`,background:aurBaja?"rgba(220,38,38,0.04)":i%2===0?"#fff":"#fafafa"}}>
                    <td style={{padding:"6px 10px",fontFamily:"monospace",fontSize:11}}>{d.label?.split(" ")[0]??""}</td>
                    <td style={{padding:"6px 10px",fontFamily:"monospace",fontSize:11}}>{d.label?.split(" ")[1]??""}</td>
                    <td style={{padding:"6px 10px",fontWeight:700,fontFamily:"monospace",color:aurBaja?C.red:!d.completo?C.muted:C.green}}>{d.AUR!=null?d.AUR.toFixed(2):!d.completo?"⏳ en curso":"—"}</td>
                    <td style={{padding:"6px 10px",fontFamily:"monospace"}}>{d.RS1!=null?d.RS1.toFixed(1):"—"}</td>
                    <td style={{padding:"6px 10px",fontFamily:"monospace"}}>{d.RS2!=null?d.RS2.toFixed(1):"—"}</td>
                    <td style={{padding:"6px 10px",fontFamily:"monospace"}}>{d.RN!=null?d.RN.toFixed(2):"—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Gráficas individuales de test ───────────────────────────
const COLORES_TEST = ["#5a9e2f","#a8c820","#2563eb","#d97706","#7c3aed","#0891b2","#dc2626","#059669"];

function GraficasPanel({data, curvas, setCurvas, cfg}){
  const [testsSelec, setTestsSelec] = useState([]);
  const [variable, setVariable] = useState("ox");
  const [cargando, setCargando] = useState(false);

  // Cargar curvas al montar
  useEffect(()=>{
    if(!curvas){
      setCargando(true);
      fetch('./curvas.json?t='+Date.now())
        .then(r=>r.ok?r.json():Promise.reject())
        .then(json=>{ setCurvas(json.curvas||{}); setCargando(false); })
        .catch(()=>setCargando(false));
    }
  },[]);

  if(!data?.length) return null;
  const valid = [...data.filter(d=>{
    const ox=d.ox_max_v1??0;
    return ox===0||ox>=2; // excluir solo O₂ bajo, incluir todos los demás
  })].reverse();

  function añadirTest(d){
    if(testsSelec.find(t=>t.id===d.id)) return;
    if(testsSelec.length >= 8) return;
    setTestsSelec(prev=>[...prev, d]);
  }

  function quitarTest(id){
    setTestsSelec(prev=>prev.filter(t=>t.id!==id));
  }

  // Construir series para la gráfica
  const series = testsSelec.map((t,i)=>{
    const raw = curvas?.[String(t.id)] || {ox:[],rs:[],t:[]};
    const arr = variable==="ox"?raw.ox : variable==="rs"?raw.rs : raw.t;
    return {
      id: t.id,
      label: t.label,
      color: COLORES_TEST[i % COLORES_TEST.length],
      puntos: (arr||[]).map((v,j)=>({ n:j, [variable]: v })),
    };
  });

  const maxPuntos = Math.max(...series.map(s=>s.puntos.length), 0);
  const chartData = Array.from({length:maxPuntos},(_,i)=>{
    const row = {n:i};
    series.forEach(s=>{ row[`t${s.id}`] = s.puntos[i]?.[variable]??null; });
    return row;
  });

  const varLabels = {ox:"Oxígeno (mg/L)", rs:"Rs (mgO₂/L·min)", t:"Temperatura (°C)"};

  return(
    <div>
      {/* Selector de test */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>➕ Seleccionar tests (máx. 8)</div>
        <div style={{overflowX:"auto",maxHeight:200,overflowY:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead style={{position:"sticky",top:0,background:"#fff"}}>
              <tr style={{borderBottom:`2px solid ${C.border}`}}>
                {["","Fecha/Hora","AUR","Rs Max 1","Rs Max 2","INH","ox inicial"].map(h=>(
                  <th key={h} style={{padding:"6px 10px",fontSize:10,color:C.muted,textTransform:"uppercase",fontWeight:700,textAlign:"left"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {valid.slice(0,200).map((d,i)=>{
                const selec = testsSelec.find(t=>t.id===d.id);
                const oxMax = parseFloat(d["ox_max_v1"]||0);
                const oxOk = oxMax >= 4;
                return(
                  <tr key={i} style={{borderBottom:`1px solid ${C.gridLine}`,background:selec?`${selec.color}15`:i%2===0?"#fff":"#fafafa",opacity:oxOk?1:0.5}}>
                    <td style={{padding:"4px 10px"}}>
                      <button onClick={()=>selec?quitarTest(d.id):añadirTest(d)} style={{
                        background:selec?COLORES_TEST[testsSelec.indexOf(selec)%8]:"#f0f0f0",
                        color:selec?"#fff":C.muted,
                        border:"none",borderRadius:6,padding:"3px 10px",fontSize:11,fontWeight:700,cursor:"pointer"
                      }}>{selec?"✓ Añadido":"+ Añadir"}</button>
                    </td>
                    <td style={{padding:"4px 10px",fontFamily:"monospace",fontSize:11}}>{d.label}</td>
                    <td style={{padding:"4px 10px",fontFamily:"monospace",color:d.AUR<cfg.aur_bajo?C.red:C.green,fontWeight:700}}>{d.AUR?.toFixed(2)??"—"}</td>
                    <td style={{padding:"4px 10px",fontFamily:"monospace"}}>{d.RS1?.toFixed(1)??"—"}</td>
                    <td style={{padding:"4px 10px",fontFamily:"monospace"}}>{d.RS2?.toFixed(1)??"—"}</td>
                    <td style={{padding:"4px 10px",fontFamily:"monospace",color:d.INH>=cfg.inh_aviso?C.red:C.text}}>{d.INH?.toFixed(0)??"—"}%</td>
                    <td style={{padding:"4px 10px",fontFamily:"monospace",color:oxOk?C.green:C.red,fontWeight:oxOk?400:700}}>{oxMax>0?oxMax.toFixed(2):"—"}{!oxOk&&oxMax>0?" ⚠️":""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Gráfica */}
      {testsSelec.length>0&&(
        <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:13,fontWeight:700}}>📉 {varLabels[variable]}</div>
            <div style={{display:"flex",gap:8}}>
              {["ox","rs","t"].map(v=>(
                <button key={v} onClick={()=>setVariable(v)} style={{
                  background:variable===v?C.green:"#f0f0f0",
                  color:variable===v?"#fff":C.muted,
                  border:"none",borderRadius:8,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer"
                }}>{v==="ox"?"Oxígeno":v==="rs"?"Rs":"Temperatura"}</button>
              ))}
            </div>
          </div>

          {cargando?(
            <div style={{textAlign:"center",padding:40,color:C.muted}}>Cargando curvas...</div>
          ):(
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData} margin={{top:4,right:8,bottom:4,left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
                <XAxis dataKey="n" tick={{fontSize:9,fill:C.muted}} label={{value:"Medida",position:"insideBottom",offset:-2,fontSize:10}}/>
                <YAxis tick={{fontSize:9,fill:C.muted}}/>
                <Tooltip content={<CT/>}/>
                <Legend/>
                {series.map(s=>(
                  <Line key={s.id} dataKey={`t${s.id}`} name={s.label}
                    stroke={s.color} strokeWidth={1.5} dot={false} connectNulls/>
                ))}
                {variable==="ox"&&<ReferenceLine y={4} stroke={C.amber} strokeDasharray="4 2" label={{value:"ox min",fill:C.amber,fontSize:9}}/>}
              </ComposedChart>
            </ResponsiveContainer>
          )}

          {/* Leyenda con resultados */}
          <div style={{marginTop:14,display:"flex",flexWrap:"wrap",gap:8}}>
            {testsSelec.map((t,i)=>(
              <div key={t.id} style={{background:`${COLORES_TEST[i%8]}15`,border:`1px solid ${COLORES_TEST[i%8]}44`,borderRadius:8,padding:"6px 12px",fontSize:11}}>
                <span style={{color:COLORES_TEST[i%8],fontWeight:700}}>●</span>
                <span style={{marginLeft:6,fontFamily:"monospace"}}>{t.label}</span>
                <span style={{marginLeft:10,color:C.muted}}>AUR: <b style={{color:t.AUR<cfg.aur_bajo?C.red:C.green}}>{t.AUR?.toFixed(2)??"—"}</b></span>
                <span style={{marginLeft:8,color:C.muted}}>INH: <b style={{color:t.INH>=cfg.inh_aviso?C.red:C.text}}>{t.INH?.toFixed(0)??"—"}%</b></span>
                <button onClick={()=>quitarTest(t.id)} style={{marginLeft:10,background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:12}}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {testsSelec.length===0&&(
        <div style={{textAlign:"center",padding:"40px 20px",color:C.muted,background:"#fff",borderRadius:16,border:"1px solid #f0f0f0"}}>
          <div style={{fontSize:32,marginBottom:12}}>📉</div>
          <div style={{fontSize:14,fontWeight:600}}>Selecciona tests de la tabla para ver sus curvas</div>
          <div style={{fontSize:12,marginTop:6}}>Tests con ⚠️ tienen oxígeno inicial bajo — aireación deficiente</div>
        </div>
      )}
    </div>
  );
}

// ── Tab: SicTox ───────────────────────────────────────────────────
function SicToxPanel({data,inhUmbral,setInhUmbral,cfg}){
  const [pagina, setPagina] = useState(0);
  const POR_PAG = 25;

  if(!data?.length) return null;
  const valid=data.filter(d=>d.valido);

  // Episodios: rachas consecutivas con INH >= umbral
  const eventos=[];
  let enEvento=false,inicio=null,maxInh=0,minAur=99,nEv=0,fechaInicio=null,ultimoEv=null,oxBajo=false;
  for(const d of valid){
    if(d.INH>=inhUmbral){
      if(!enEvento){enEvento=true;inicio=d;maxInh=d.INH;minAur=d.AUR??null;nEv=1;fechaInicio=d.datetime;ultimoEv=d;oxBajo=(d.ox_max_v1??0)>0&&(d.ox_max_v1??0)<2;}
      else{
        maxInh=Math.max(maxInh,d.INH);
        if(d.AUR!=null) minAur=(minAur==null)?d.AUR:Math.min(minAur,d.AUR);
        nEv++; ultimoEv=d;
        if((d.ox_max_v1??0)>0&&(d.ox_max_v1??0)<2) oxBajo=true;
      }
    }else if(enEvento){
      enEvento=false;
      const durH=+Math.min(24,(ultimoEv.datetime-fechaInicio)/3600000).toFixed(1);
      eventos.push({inicio:inicio.label,fechaInicio,finDatetime:ultimoEv.datetime,maxInh,minAur,n:nEv,durH,
        confirmado:minAur!=null&&minAur<cfg.aur_bajo,critico:maxInh>=cfg.inh_critico,falsaAlarma:oxBajo});
      oxBajo=false;
    }
  }
  if(enEvento){
    const durH=+Math.min(24,(ultimoEv.datetime-fechaInicio)/3600000).toFixed(1);
    eventos.push({inicio:inicio.label,fechaInicio,finDatetime:ultimoEv.datetime,maxInh,minAur,n:nEv,durH,
      confirmado:minAur!=null&&minAur<cfg.aur_bajo,critico:maxInh>=cfg.inh_critico,falsaAlarma:oxBajo});
  }

  // Ordenar por fecha descendente
  const eventosOrdenados=[...eventos].sort((a,b)=>b.fechaInicio-a.fechaInicio);
  const totalPags=Math.ceil(eventosOrdenados.length/POR_PAG);
  const paginaActual=eventosOrdenados.slice(pagina*POR_PAG,(pagina+1)*POR_PAG);

  const nConf=eventos.filter(e=>e.confirmado).length;
  const nCrit=eventos.filter(e=>e.critico).length;

  // Gráfica INH histórica completa (media diaria) — todos los datos
  const porDia={};
  valid.forEach(d=>{
    const k=d.datetime.toISOString().slice(0,10);
    if(!porDia[k]) porDia[k]={fecha:k,inhMax:0,inhMedia:0,n:0,nAlta:0};
    porDia[k].inhMax=Math.max(porDia[k].inhMax,d.INH);
    porDia[k].inhMedia+=d.INH; porDia[k].n++;
    if(d.INH>=inhUmbral) porDia[k].nAlta++;
  });
  const histDiario=Object.values(porDia)
    .map(d=>({...d,inhMedia:+(d.inhMedia/d.n).toFixed(1),pico:d.inhMax>=inhUmbral?d.inhMax:null}))
    .sort((a,b)=>a.fecha.localeCompare(b.fecha));

  // Por dia semana
  const DIAS=["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
  const byDia=DIAS.map((d,i)=>{
    const sub=valid.filter(r=>r.diaSemana===i);
    return{dia:d,inh:sub.length?+(sub.reduce((s,r)=>s+r.INH,0)/sub.length).toFixed(1):0,
      pct20:sub.length?+(100*sub.filter(r=>r.INH>=cfg.inh_aviso).length/sub.length).toFixed(1):0,
      n:sub.length,esVie:i===5};
  });

  return(
    <div style={{marginBottom:14}}>
      {/* Header + KPIs */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
          <div>
            <div style={{fontSize:13,fontWeight:700}}>☣️ SicTox — Episodios de inhibición tóxica</div>
            <div style={{fontSize:11,color:C.muted,marginTop:2}}>Tests válidos (Rs Max 1 &gt; {cfg.rs_min}) · {valid.length} registros · {data[0]?.datetime?.toISOString().slice(0,10)} → {data.at(-1)?.datetime?.toISOString().slice(0,10)}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 12px"}}>
            <span style={{fontSize:11,color:C.muted}}>Umbral detección:</span>
            <input type="range" min={10} max={80} value={inhUmbral} onChange={e=>{setInhUmbral(+e.target.value);setPagina(0);}} style={{width:70,accentColor:C.red}}/>
            <span style={{fontSize:13,fontWeight:700,color:C.red,fontFamily:"monospace",minWidth:36}}>{inhUmbral}%</span>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
          <KpiCard icon="☣️" label="Episodios total"      value={eventos.length} unit={`INH ≥ ${inhUmbral}%`}           color={C.amber}/>
          <KpiCard icon="🚨" label="Vertidos confirmados" value={nConf}          unit="INH alta + AUR baja simultáneos" color={C.purple}/>
          <KpiCard icon="🔴" label="Episodios críticos"   value={nCrit}          unit={`INH ≥ ${cfg.inh_critico}%`}    color={C.red}/>
          <KpiCard icon="📅" label="Período analizado"    value={`${Math.round((data.at(-1)?.datetime-data[0]?.datetime)/86400000/30)} meses`} unit={`${valid.length} tests válidos`} color={C.blue}/>
        </div>

        {/* Gráfica histórica INH */}
        <div style={{fontSize:11,fontWeight:600,color:C.muted,marginBottom:6}}>INH máxima diaria — histórico completo</div>
        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={histDiario} margin={{top:4,right:8,bottom:4,left:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
            <XAxis dataKey="fecha" tick={{fontSize:8,fill:C.muted}} interval={Math.floor(histDiario.length/10)} angle={-20} textAnchor="end" height={36}/>
            <YAxis domain={[0,105]} tick={{fontSize:9,fill:C.muted}} unit="%"/>
            <Tooltip content={<CT/>}/>
            <ReferenceLine y={inhUmbral}        stroke={C.amber} strokeDasharray="4 2" label={{value:`${inhUmbral}%`,fill:C.amber,fontSize:9}}/>
            <ReferenceLine y={cfg.inh_critico}  stroke={C.red}   strokeDasharray="4 2" label={{value:`${cfg.inh_critico}%`,fill:C.red,fontSize:9}}/>
            <Area dataKey="inhMax"   fill={C.redFade}  stroke={C.red}   strokeWidth={1}   dot={false} name="INH máx diaria" connectNulls/>
            <Line dataKey="inhMedia" stroke={C.amber}  strokeWidth={1.5} dot={false} name="INH media diaria" connectNulls/>
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla unificada episodios + desfase */}
      {(()=>{
        const validAur=valid.filter(d=>d.AUR!=null&&d.AUR>0);
        const eventosConDesfase=eventosOrdenados.map(e=>{
          const t0=e.fechaInicio;
          const ventana=validAur.filter(r=>{const dh=(r.datetime-t0)/3600000;return dh>=0&&dh<=12;});
          if(!ventana.length) return {...e,desfaseH:null,durImpacto:null};
          const minR=ventana.reduce((m,r)=>r.AUR<m.AUR?r:m);
          const desfaseH=+((minR.datetime-t0)/3600000).toFixed(1);
          const rec=validAur.find(r=>r.datetime>minR.datetime&&r.AUR>=cfg.aur_bajo);
          const durImpacto=rec?+Math.min(24,(rec.datetime-minR.datetime)/3600000).toFixed(1):null;
          const ok=desfaseH>=0&&desfaseH<=12&&e.durH<=12;
          return{...e,desfaseH:ok?desfaseH:null,durImpacto:ok&&durImpacto!=null&&durImpacto<=24?durImpacto:null};
        });
        const conDesfase=eventosConDesfase.filter(e=>e.desfaseH!=null&&e.confirmado);
        const mediaDesfase=conDesfase.length?+(conDesfase.reduce((s,e)=>s+e.desfaseH,0)/conDesfase.length).toFixed(1):null;
        const histDesfase=[{l:"<1h",min:0,max:1},{l:"1-2h",min:1,max:2},{l:"2-4h",min:2,max:4},{l:"4-6h",min:4,max:6},{l:"6-12h",min:6,max:12}]
          .map(b=>({label:b.l,n:conDesfase.filter(e=>e.desfaseH>=b.min&&e.desfaseH<b.max).length})).filter(b=>b.n>0);
        const byHora=Array.from({length:24},(_,h)=>{
          const sub=conDesfase.filter(e=>e.fechaInicio.getHours()===h);
          return{hora:`${String(h).padStart(2,'0')}h`,n:sub.length,desfaseMedio:sub.length?+(sub.reduce((s,e)=>s+e.desfaseH,0)/sub.length).toFixed(1):null};
        }).filter(b=>b.n>0);
        return(<>
          <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{fontSize:13,fontWeight:700}}>📋 Todos los episodios — {eventos.length} total</div>
                {mediaDesfase&&<Badge color={C.amber}>⏱ Desfase medio: {mediaDesfase}h</Badge>}
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <button onClick={()=>setPagina(p=>Math.max(0,p-1))} disabled={pagina===0} style={{background:pagina===0?"#f0f0f0":C.green,color:pagina===0?C.muted:"#fff",border:"none",borderRadius:6,padding:"4px 12px",fontSize:12,fontWeight:700,cursor:pagina===0?"default":"pointer"}}>←</button>
                <span style={{fontSize:12,color:C.muted}}>{pagina+1} / {totalPags||1}</span>
                <button onClick={()=>setPagina(p=>Math.min(totalPags-1,p+1))} disabled={pagina>=totalPags-1} style={{background:pagina>=totalPags-1?"#f0f0f0":C.green,color:pagina>=totalPags-1?C.muted:"#fff",border:"none",borderRadius:6,padding:"4px 12px",fontSize:12,fontWeight:700,cursor:pagina>=totalPags-1?"default":"pointer"}}>→</button>
              </div>
            </div>
            {eventosConDesfase.length>0?(
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr style={{borderBottom:`2px solid ${C.border}`}}>
                    {["Fecha inicio","INH máx","AUR mín","⏱ Desfase","Dur. vertido","Dur. impacto","Tests","Estado"].map(h=>(
                      <th key={h} style={{padding:"8px 10px",fontSize:10,color:C.muted,textTransform:"uppercase",fontWeight:700,textAlign:"left"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{eventosConDesfase.slice(pagina*POR_PAG,(pagina+1)*POR_PAG).map((e,i)=>{
                    const col=e.falsaAlarma?C.blue:e.critico?C.red:e.confirmado?C.purple:C.amber;
                    return(
                      <tr key={i} style={{borderBottom:`1px solid ${C.gridLine}`,background:i%2===0?"#fff":"#fafafa"}}>
                        <td style={{padding:"8px 10px",fontFamily:"monospace",fontSize:11,fontWeight:600}}>{e.inicio}</td>
                        <td style={{padding:"8px 10px",fontWeight:800,color:e.maxInh>=cfg.inh_critico?C.red:C.amber,fontFamily:"monospace",fontSize:13}}>{e.maxInh.toFixed(0)}%</td>
                        <td style={{padding:"8px 10px",fontWeight:800,color:e.minAur!=null&&e.minAur<cfg.aur_bajo?C.red:C.green,fontFamily:"monospace"}}>{e.minAur!=null?e.minAur.toFixed(2):"—"}</td>
                        <td style={{padding:"8px 10px",fontFamily:"monospace",color:e.desfaseH!=null?(e.desfaseH<2?C.red:e.desfaseH<4?C.amber:C.green):C.muted}}>{e.desfaseH!=null?`${e.desfaseH}h`:"—"}</td>
                        <td style={{padding:"8px 10px",fontFamily:"monospace",color:e.durH>=3?C.red:e.durH>=1?C.amber:C.muted}}>{e.durH===0?"1 test":`${e.durH}h`}</td>
                        <td style={{padding:"8px 10px",fontFamily:"monospace",color:e.durImpacto!=null?C.text:C.muted}}>{e.durImpacto!=null?`${e.durImpacto}h`:"—"}</td>
                        <td style={{padding:"8px 10px",color:C.muted}}>{e.n}</td>
                        <td style={{padding:"8px 10px"}}><Badge color={col}>{e.falsaAlarma?"🔵 FALSA ALARMA (O₂)":e.critico?"🔴 CRÍTICO":e.confirmado?"🟣 CONFIRMADO":"🟡 ALERTA"}</Badge></td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            ):(
              <div style={{textAlign:"center",padding:"24px",color:C.muted,fontSize:13}}>✅ Sin episodios con INH ≥ {inhUmbral}%</div>
            )}
            <div style={{marginTop:8,fontSize:11,color:C.muted}}>Mostrando {pagina*POR_PAG+1}–{Math.min((pagina+1)*POR_PAG,eventos.length)} de {eventos.length}</div>
          </div>
          {conDesfase.length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
              <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
                <div style={{fontSize:13,fontWeight:700,marginBottom:4}}>⏱ Distribución desfase INH→AUR</div>
                <div style={{fontSize:11,color:C.muted,marginBottom:10}}>Horas desde detección hasta colapso AUR · vertidos confirmados</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={histDesfase} margin={{top:4,right:8,bottom:4,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
                    <XAxis dataKey="label" tick={{fontSize:10,fill:C.muted}}/>
                    <YAxis tick={{fontSize:9,fill:C.muted}} allowDecimals={false}/>
                    <Tooltip content={<CT/>}/>
                    <Bar dataKey="n" name="Episodios" fill={C.red} radius={[4,4,0,0]} opacity={0.8}/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
                <div style={{fontSize:13,fontWeight:700,marginBottom:4}}>🕐 Desfase medio por hora de entrada</div>
                <div style={{fontSize:11,color:C.muted,marginBottom:10}}>Vertidos de mañana dan más margen de reacción</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={byHora} margin={{top:4,right:8,bottom:4,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
                    <XAxis dataKey="hora" tick={{fontSize:9,fill:C.muted}}/>
                    <YAxis tick={{fontSize:9,fill:C.muted}} unit="h" domain={[0,12]}/>
                    <Tooltip content={<CT/>}/>
                    {mediaDesfase&&<ReferenceLine y={mediaDesfase} stroke={C.amber} strokeDasharray="4 2" label={{value:`media ${mediaDesfase}h`,fill:C.amber,fontSize:9}}/>}
                    <Bar dataKey="desfaseMedio" name="Desfase medio (h)" fill={C.amber} radius={[4,4,0,0]} opacity={0.85}/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>);
      })()}

      {/* Análisis de duración */}
      {eventos.length>0&&(()=>{
        // Histograma duración (cap 12h, ignorar outliers >24h)
        const evFilt = eventos.filter(e=>e.durH<=24);
        const buckets = [{l:"1 test",min:0,max:0.01},{l:"<1h",min:0.01,max:1},{l:"1-3h",min:1,max:3},{l:"3-6h",min:3,max:6},{l:"6-12h",min:6,max:12},{l:">12h",min:12,max:9999}];
        const histDur = buckets.map(b=>({label:b.l, n:eventos.filter(e=>e.durH>=b.min&&e.durH<b.max).length})).filter(b=>b.n>0);
        const conDur = evFilt.filter(e=>e.durH>0);
        const mediaDur = conDur.length ? +(conDur.reduce((s,e)=>s+e.durH,0)/conDur.length).toFixed(1) : null;
        return(
          <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{fontSize:13,fontWeight:700}}>⏳ Duración de los episodios</div>
                <div style={{fontSize:11,color:C.muted,marginTop:2}}>El 64% son de 1 solo test · episodios prolongados indican vertido sostenido</div>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {mediaDur&&<Badge color={C.amber}>Media (excl. 1 test): {mediaDur}h</Badge>}
                <Badge color={C.red}>{eventos.filter(e=>e.durH>=3).length} episodios ≥ 3h</Badge>
                <Badge color={C.purple}>{eventos.filter(e=>e.confirmado&&e.durH>=3).length} vertidos confirmados prolongados</Badge>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <div>
                <div style={{fontSize:11,color:C.muted,marginBottom:6}}>Distribución por duración</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={histDur} margin={{top:4,right:8,bottom:4,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
                    <XAxis dataKey="label" tick={{fontSize:10,fill:C.muted}}/>
                    <YAxis tick={{fontSize:9,fill:C.muted}} allowDecimals={false}/>
                    <Tooltip content={<CT/>}/>
                    <Bar dataKey="n" name="Episodios" fill={C.red} radius={[4,4,0,0]} opacity={0.8}/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <div style={{fontSize:11,color:C.muted,marginBottom:6}}>Duración vs INH máx (episodios &gt; 1 test)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <ScatterChart margin={{top:4,right:8,bottom:4,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
                    <XAxis dataKey="durH" name="Duración (h)" tick={{fontSize:9,fill:C.muted}} unit="h" type="number"/>
                    <YAxis dataKey="maxInh" name="INH máx" tick={{fontSize:9,fill:C.muted}} unit="%" domain={[0,105]}/>
                    <Tooltip cursor={{strokeDasharray:"3 3"}} content={<CT/>}/>
                    <ReferenceLine y={cfg.inh_critico} stroke={C.red} strokeDasharray="4 2"/>
                    <Scatter data={evFilt.filter(e=>e.durH>0).map(e=>({durH:e.durH,maxInh:e.maxInh,confirmado:e.confirmado}))}
                      fill={C.red} opacity={0.7} shape="circle"/>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Por día semana */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:4}}>📅 Patrón por día de semana</div>
        <div style={{fontSize:11,color:C.muted,marginBottom:12}}>Viernes = mayor inhibición (p&lt;0.001) — efecto arrastre sábado/domingo</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div>
            <div style={{fontSize:11,color:C.muted,marginBottom:6}}>INH media por día</div>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={byDia} margin={{top:4,right:8,bottom:4,left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
                <XAxis dataKey="dia" tick={{fontSize:10,fill:C.muted}}/>
                <YAxis tick={{fontSize:9,fill:C.muted}} unit="%"/>
                <Tooltip content={<CT/>}/>
                <Bar dataKey="inh" name="INH media" radius={[4,4,0,0]} fill={C.amber}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div>
            <div style={{fontSize:11,color:C.muted,marginBottom:6}}>% tests con INH&gt;{cfg.inh_aviso}%</div>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={byDia} margin={{top:4,right:8,bottom:4,left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
                <XAxis dataKey="dia" tick={{fontSize:10,fill:C.muted}}/>
                <YAxis tick={{fontSize:9,fill:C.muted}} unit="%"/>
                <Tooltip content={<CT/>}/>
                <Bar dataKey="pct20" name={`% INH>${cfg.inh_aviso}%`} fill={C.red} radius={[4,4,0,0]} opacity={0.8}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Modelo de riesgo (coeficientes calibrados del histórico) ──────
const MODEL = {
  intercept: -0.3973,
  coefs: {inh_roll6:1.5498, inh_trend:0.3816, hour:0.1803, month:0.1533, inh_roll3:0.1606, inh_prev1:0.0856, dow:-0.0044},
  means: {inh_roll6:9.163, inh_trend:-0.0124, hour:11.62, month:6.47, inh_roll3:9.157, inh_prev1:9.153, dow:2.988},
  stds:  {inh_roll6:13.292, inh_trend:16.533, hour:6.922, month:2.986, inh_roll3:14.371, inh_prev1:16.566, dow:1.983},
  auc: 0.832,
};
// Riesgo por hora del día (calibrado del histórico)
const HOUR_RISK = [0.25,0.25,0.25,0.26,0.26,0.26,0.22,0.22,0.22,0.17,0.17,0.17,0.18,0.18,0.18,0.22,0.22,0.22,0.24,0.24,0.24,0.24,0.24,0.25];
const DOW_RISK  = [0.22,0.21,0.21,0.23,0.24,0.23,0.22]; // Dom-Sáb (getDay: 0=Dom)
const DIAS_ES   = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];


function calcRiesgo(data) {
  if(!data?.length) return null;
  const valid=data.filter(d=>d.valido).slice(-10);
  if(valid.length<2) return null;
  const last=valid.at(-1);
  const now=last.datetime;
  const hour=now.getHours(), month=now.getMonth()+1, dow=now.getDay();

  // Rolling features
  const inh_prev1 = valid.length>=2 ? valid.at(-2).INH : 0;
  const roll3 = valid.slice(-3).reduce((s,d)=>s+d.INH,0)/Math.min(3,valid.length);
  const roll6 = valid.slice(-6).reduce((s,d)=>s+d.INH,0)/Math.min(6,valid.length);
  const trend  = valid.length>=4 ? valid.at(-1).INH - valid.at(-4).INH : 0;

  const feats = {inh_roll6:roll6, inh_trend:trend, hour, month, inh_roll3:roll3, inh_prev1, dow};

  // Standardize and compute logit
  let logit = MODEL.intercept;
  for(const [k,v] of Object.entries(feats)) {
    const z = (v - MODEL.means[k]) / MODEL.stds[k];
    logit += MODEL.coefs[k] * z;
  }
  const prob = sigmoid(logit);
  const score = Math.round(prob * 100);

  // Contributions breakdown
  const contribs = Object.entries(feats).map(([k,v])=>{
    const z=(v-MODEL.means[k])/MODEL.stds[k];
    return {key:k, contrib:MODEL.coefs[k]*z, valor:v};
  }).sort((a,b)=>Math.abs(b.contrib)-Math.abs(a.contrib));

  return {score, prob, hour, dow, month, roll3:+roll3.toFixed(1), roll6:+roll6.toFixed(1), trend:+trend.toFixed(1), inh_prev1, contribs, last};
}

// ── Tab: Riesgo de vertido ────────────────────────────────────────
function RiesgoPanel({data,cfg}){
  if(!data?.length) return null;
  const valid=data.filter(d=>d.valido);
  if(valid.length<3) return(
    <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"32px",textAlign:"center",color:C.muted,marginBottom:14}}>
      <div style={{fontSize:32,marginBottom:12}}>🎯</div>
      <div style={{fontSize:14,fontWeight:600}}>Necesitas al menos 3 tests válidos para calcular el riesgo</div>
    </div>
  );

  const r = calcRiesgo(valid);
  if(!r) return null;

  const col = r.score>=70?C.red:r.score>=40?C.amber:C.green;
  const nivel = r.score>=70?"ALTO":r.score>=40?"MEDIO":"BAJO";
  const emoji = r.score>=70?"🔴":r.score>=40?"🟡":"🟢";

  // Probabilidad por hora para las próximas 24h (desde la última medida)
  const proximas24 = Array.from({length:24},(_,i)=>{
    const h=(r.hour+i)%24;
    const d=(r.dow+Math.floor((r.hour+i)/24))%7;
    // Ajustar prob base con factor horario y día
    const baseHour = HOUR_RISK[h]/0.22; // normalizado sobre media
    const baseDow  = DOW_RISK[d]/0.22;
    const adjProb  = Math.min(0.99, r.prob * baseHour * baseDow * 0.8 + HOUR_RISK[h]*0.2);
    return {hora:`+${i}h (${h.toString().padStart(2,'0')}:00)`, h, d, prob:+(adjProb*100).toFixed(1)};
  });

  // Probabilidad histórica diaria (rolling 7d por semana)
  const porDia={};
  valid.forEach(d=>{
    const k=d.datetime.toISOString().slice(0,10);
    if(!porDia[k]) porDia[k]={fecha:k,inhMax:0,n:0,nAlta:0,dow:d.diaSemana};
    porDia[k].inhMax=Math.max(porDia[k].inhMax,d.INH);
    porDia[k].n++; if(d.INH>=cfg.inh_aviso) porDia[k].nAlta++;
  });
  const diasHist=Object.values(porDia).sort((a,b)=>a.fecha.localeCompare(b.fecha))
    .map(d=>({...d,riesgo:+(d.nAlta/d.n*100).toFixed(0)}));

  const CONTRIB_LABELS={
    inh_roll6:"INH media últimas 6 medidas", inh_roll3:"INH media últimas 3 medidas",
    inh_trend:"Tendencia INH (últimas 4 medidas)", inh_prev1:"INH medida anterior",
    hour:"Hora del día", month:"Mes del año", dow:"Día de la semana",
  };

  return(
    <div style={{marginBottom:14}}>
      {/* Score principal */}
      <div style={{background:"#fff",border:`2px solid ${col}33`,borderRadius:16,padding:"24px 28px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{display:"flex",alignItems:"center",gap:32,flexWrap:"wrap"}}>
          {/* Gauge */}
          <div style={{textAlign:"center",flexShrink:0}}>
            <svg width={140} height={80} viewBox="0 0 140 80">
              {/* Background arc */}
              <path d="M 10 75 A 60 60 0 0 1 130 75" fill="none" stroke="#f0f0f0" strokeWidth={14} strokeLinecap="round"/>
              {/* Color arc */}
              <path d="M 10 75 A 60 60 0 0 1 130 75" fill="none"
                stroke={`url(#riskGrad)`} strokeWidth={14} strokeLinecap="round"
                strokeDasharray={`${r.score*1.885} 188.5`}/>
              <defs>
                <linearGradient id="riskGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor={C.green}/>
                  <stop offset="50%" stopColor={C.amber}/>
                  <stop offset="100%" stopColor={C.red}/>
                </linearGradient>
              </defs>
              <text x="70" y="68" textAnchor="middle" fontSize="26" fontWeight="900" fill={col} fontFamily="monospace">{r.score}</text>
            </svg>
            <div style={{fontSize:11,color:C.muted,marginTop:4}}>/ 100</div>
            <Badge color={col}>{emoji} RIESGO {nivel}</Badge>
          </div>
          {/* Info */}
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:16,fontWeight:800,color:col,marginBottom:8}}>
              {r.score>=70?"⚠️ Alta probabilidad de vertido en próximas medidas":
               r.score>=40?"👀 Vigilancia — patrón de inhibición creciente":
               "✅ Sin señales de vertido inminente"}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:12}}>
              {[
                {l:"INH media 6 tests",  v:`${r.roll6}%`,    c:r.roll6>=20?C.red:r.roll6>=10?C.amber:C.green},
                {l:"Tendencia INH",       v:r.trend>=0?`+${r.trend}%`:`${r.trend}%`, c:r.trend>5?C.red:r.trend>0?C.amber:C.green},
                {l:"INH test anterior",  v:`${r.inh_prev1}%`, c:r.inh_prev1>=20?C.red:r.inh_prev1>=10?C.amber:C.green},
                {l:"Hora actual",        v:`${r.hour.toString().padStart(2,'0')}:00`, c:C.text},
                {l:"Día semana",         v:DIAS_ES[r.dow],   c:r.dow===5?C.amber:C.text},
                {l:"Prob. modelo",       v:`${(r.prob*100).toFixed(1)}%`, c:col},
              ].map(({l,v,c})=>(
                <div key={l} style={{background:C.panel,borderRadius:8,padding:"8px 12px"}}>
                  <div style={{fontSize:10,color:C.muted}}>{l}</div>
                  <div style={{fontSize:15,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div>
                </div>
              ))}
            </div>
          </div>
          {/* Contribuciones */}
          <div style={{minWidth:220}}>
            <div style={{fontSize:11,fontWeight:600,color:C.muted,marginBottom:8}}>Factores que contribuyen al score:</div>
            {r.contribs.slice(0,5).map(({key,contrib})=>{
              const pct=Math.min(100,Math.abs(contrib)*30);
              const pos=contrib>0;
              return(
                <div key={key} style={{marginBottom:6}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
                    <span style={{color:C.muted}}>{CONTRIB_LABELS[key]||key}</span>
                    <span style={{color:pos?C.red:C.green,fontWeight:600}}>{pos?"↑":"↓"} {Math.abs(contrib).toFixed(2)}</span>
                  </div>
                  <div style={{height:5,background:C.gridLine,borderRadius:3,overflow:"hidden"}}>
                    <div style={{width:`${pct}%`,height:"100%",background:pos?C.red:C.green,borderRadius:3}}/>
                  </div>
                </div>
              );
            })}
            <div style={{fontSize:10,color:C.muted,marginTop:8}}>Modelo calibrado con {valid.length} tests · AUC = {MODEL.auc}</div>
          </div>
        </div>
      </div>

      {/* Próximas 24h */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:4}}>🕐 Estimación de riesgo — próximas 24 horas</div>
        <div style={{fontSize:11,color:C.muted,marginBottom:12}}>Basado en el patrón horario histórico ajustado al nivel de INH actual</div>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={proximas24} margin={{top:4,right:8,bottom:20,left:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
            <XAxis dataKey="hora" tick={{fontSize:8,fill:C.muted}} interval={2} angle={-30} textAnchor="end" height={40}/>
            <YAxis domain={[0,100]} tick={{fontSize:9,fill:C.muted}} unit="%"/>
            <Tooltip content={<CT/>}/>
            <ReferenceLine y={40} stroke={C.amber} strokeDasharray="4 2"/>
            <ReferenceLine y={70} stroke={C.red}   strokeDasharray="4 2"/>
            <Bar dataKey="prob" name="Prob. vertido %" radius={[3,3,0,0]}
              fill={C.amber}
              label={false}/>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Histórico riesgo diario */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:4}}>📅 Días con inhibición real — histórico completo</div>
        <div style={{fontSize:11,color:C.muted,marginBottom:12}}>% tests con INH&gt;{cfg.inh_aviso}% por día · validado sobre {valid.length} medidas</div>
        <ResponsiveContainer width="100%" height={130}>
          <ComposedChart data={diasHist} margin={{top:4,right:8,bottom:4,left:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine}/>
            <XAxis dataKey="fecha" tick={{fontSize:8,fill:C.muted}} interval={Math.floor(diasHist.length/12)} angle={-20} textAnchor="end" height={36}/>
            <YAxis domain={[0,100]} tick={{fontSize:9,fill:C.muted}} unit="%"/>
            <Tooltip content={<CT/>}/>
            <ReferenceLine y={40} stroke={C.amber} strokeDasharray="4 2"/>
            <Bar dataKey="riesgo" name="% tests INH>20%" fill={C.red} opacity={0.6} radius={[2,2,0,0]}/>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Tab: Alertas ──────────────────────────────────────────────────
function AlertasPanel({alertas,setAlertas,disparadas,cfg,setCfg}){
  const upd=(id,key,val)=>setAlertas(prev=>prev.map(a=>a.id===id?{...a,[key]:val}:a));
  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
      {/* Alertas */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:14}}>🔔 Alertas activas</div>
        <div style={{display:"grid",gap:8}}>
          {alertas.map(a=>{
            const disp=disparadas.find(d=>d.id===a.id);
            return(
              <div key={a.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:disp?a.severidad==="critica"?C.redFade:C.amberFade:C.panel,borderRadius:8,border:`1px solid ${disp?a.severidad==="critica"?C.red:C.amber:C.border}`}}>
                <span style={{fontSize:16}}>{a.icon}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:600}}>{a.label}</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>
                    <span style={{fontSize:10,color:C.muted}}>{a.tipo==="min"?"Mín:":"Máx:"}</span>
                    <input type="number" value={a.valor} step={a.campo==="AUR"?0.1:1} onChange={e=>upd(a.id,"valor",parseFloat(e.target.value)||0)} style={{width:55,border:`1px solid ${C.border}`,borderRadius:5,padding:"2px 6px",fontSize:11,fontWeight:700}}/>
                    <span style={{fontSize:10,color:C.muted}}>{a.unit}</span>
                  </div>
                </div>
                {disp&&<Badge color={a.severidad==="critica"?C.red:C.amber}>⚡ {disp.valorActual}</Badge>}
                <Badge color={a.severidad==="critica"?C.red:C.amber}>{a.severidad}</Badge>
                <div onClick={()=>upd(a.id,"activa",!a.activa)} style={{width:34,height:18,borderRadius:9,background:a.activa?C.green:C.gridLine,cursor:"pointer",position:"relative",transition:"all .2s",flexShrink:0}}>
                  <div style={{position:"absolute",top:2,left:a.activa?16:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:"all .2s"}}/>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {/* Umbrales */}
      <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:14}}>⚙️ Umbrales del sistema</div>
        <div style={{display:"grid",gap:12}}>
          {[
            {key:"rs_min",    label:"Rs Max mínimo (validez test)", unit:"mgO₂/L·h", step:1, desc:"Tests con Rs1 y Rs2 por encima de este valor"},
            {key:"inh_aviso", label:"INH alerta",                  unit:"%",         step:1, desc:"Umbral para alerta de inhibición"},
            {key:"inh_critico",label:"INH crítico",                unit:"%",         step:1, desc:"Umbral para alerta crítica y acción"},
            {key:"aur_bajo",  label:"AUR baja (P25 histórico)",    unit:"mgO₂/gSSV·h",step:0.01,desc:"Percentil 25 del histórico limpio"},
            {key:"aur_ref",   label:"AUR referencia (mediana)",    unit:"mgO₂/gSSV·h",step:0.01,desc:"Mediana días sin vertido"},
            {key:"kw_soplante",label:"Potencia soplante",          unit:"kW",        step:0.5, desc:"Para cálculo de ahorro energético"},
            {key:"eur_kwh",   label:"Precio energía",              unit:"€/kWh",     step:0.01,desc:"Tarifa eléctrica vigente"},
          ].map(({key,label,unit,step,desc})=>(
            <div key={key}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                <div style={{fontSize:12,fontWeight:600}}>{label}</div>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <input type="number" value={cfg[key]} step={step} onChange={e=>setCfg(prev=>({...prev,[key]:parseFloat(e.target.value)||0}))}
                    style={{width:70,border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 8px",fontSize:12,fontWeight:700,textAlign:"center"}}/>
                  <span style={{fontSize:11,color:C.muted,minWidth:70}}>{unit}</span>
                  <button onClick={()=>setCfg(prev=>({...prev,[key]:DEFAULTS[key]}))} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:5,padding:"3px 8px",fontSize:10,color:C.muted,cursor:"pointer"}}>reset</button>
                </div>
              </div>
              <div style={{fontSize:10,color:C.muted}}>{desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Tab: Calidad datos ────────────────────────────────────────────
function CalidadPanel({data,cfg}){
  if(!data?.length) return null;
  const total=data.length;
  const invRs  = data.filter(d=>d.RS1!=null&&d.RS1<=cfg.rs_min).length;
  const invOx  = data.filter(d=>(d.ox_max_v1??0)>0&&(d.ox_max_v1??0)<2).length;
  const valid  = data.filter(d=>d.valido).length;
  const inv    = total-valid;
  const pctInv = +(100*inv/total).toFixed(1);
  const byMes={};
  data.forEach(d=>{
    const k=d.datetime.toISOString().slice(0,7);
    if(!byMes[k]) byMes[k]={mes:k,total:0,valid:0,invRs:0,invOx:0};
    byMes[k].total++;
    if(d.valido) byMes[k].valid++;
    else{
      if(d.RS1!=null&&d.RS1<=cfg.rs_min) byMes[k].invRs++;
      if((d.ox_max_v1??0)>0&&(d.ox_max_v1??0)<2) byMes[k].invOx++;
    }
  });
  const meses=Object.values(byMes).map(m=>({...m,
    pctInv:+(100*(m.total-m.valid)/m.total).toFixed(1),
  }));
  return(
    <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:14}}>🔬 Calidad de datos — filtro O₂ inicial ≥ 2 mg/L</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
        <KpiCard icon="📊" label="Total tests"       value={total}   unit="registros brutos"         color={C.text}/>
        <KpiCard icon="✅" label="Tests válidos"     value={valid}   unit="O₂ inicial ≥ 2 mg/L"          color={C.green}/>
        <KpiCard icon="📡" label="Inválidos por Rs"  value={invRs}   unit={`Rs1 ≤ ${cfg.rs_min}`}    color={invRs>100?C.red:C.amber}/>
        <KpiCard icon="💨" label="Inválidos por O₂" value={invOx}   unit="O₂ inicial < 4 mg/L"      color={invOx>100?C.red:C.amber}/>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead><tr style={{borderBottom:`2px solid ${C.border}`}}>
            {["Mes","Total","Válidos","% Inválidos","Inv. Rs","Inv. O₂"].map(h=>(
              <th key={h} style={{padding:"8px 10px",fontSize:10,color:C.muted,textTransform:"uppercase",fontWeight:700,textAlign:"right"}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>{meses.map((m,i)=>(
            <tr key={m.mes} style={{borderBottom:`1px solid ${C.gridLine}`,background:i%2===0?"#fff":"#fafafa"}}>
              <td style={{padding:"8px 10px",fontWeight:600,fontFamily:"monospace"}}>{m.mes}</td>
              <td style={{padding:"8px 10px",textAlign:"right",color:C.muted}}>{m.total}</td>
              <td style={{padding:"8px 10px",textAlign:"right",color:C.green,fontWeight:700}}>{m.valid}</td>
              <td style={{padding:"8px 10px",textAlign:"right"}}><Badge color={m.pctInv>30?C.red:C.amber}>{m.pctInv}%</Badge></td>
              <td style={{padding:"8px 10px",textAlign:"right",color:m.invRs>20?C.red:C.muted}}>{m.invRs}</td>
              <td style={{padding:"8px 10px",textAlign:"right",color:m.invOx>20?C.red:C.muted}}>{m.invOx}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab: Incidencias ──────────────────────────────────────────────
function IncidenciasPanel({incidencias,setIncidencias}){
  const [tipo,setTipo]=useState("vertido");
  const [texto,setTexto]=useState("");
  const [fecha,setFecha]=useState(new Date().toISOString().slice(0,16));
  const agregar=()=>{
    if(!texto.trim()) return;
    setIncidencias(prev=>[{id:Date.now(),tipo,texto:texto.trim(),fecha},...prev]);
    setTexto(""); setFecha(new Date().toISOString().slice(0,16));
  };
  return(
    <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"18px 20px",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:14}}>📋 Registro de incidencias</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 2fr auto",gap:10,marginBottom:16,alignItems:"end"}}>
        <div>
          <div style={{fontSize:11,color:C.muted,marginBottom:4}}>Tipo</div>
          <select value={tipo} onChange={e=>setTipo(e.target.value)} style={{width:"100%",border:`1px solid ${C.border}`,borderRadius:6,padding:"6px 10px",fontSize:12}}>
            {TIPOS_INC.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <div style={{fontSize:11,color:C.muted,marginBottom:4}}>Fecha/hora</div>
          <input type="datetime-local" value={fecha} onChange={e=>setFecha(e.target.value)} style={{width:"100%",border:`1px solid ${C.border}`,borderRadius:6,padding:"6px 10px",fontSize:12,boxSizing:"border-box"}}/>
        </div>
        <div>
          <div style={{fontSize:11,color:C.muted,marginBottom:4}}>Descripción</div>
          <input value={texto} onChange={e=>setTexto(e.target.value)} placeholder="Observación..." style={{width:"100%",border:`1px solid ${C.border}`,borderRadius:6,padding:"6px 10px",fontSize:12,boxSizing:"border-box"}}/>
        </div>
        <button onClick={agregar} disabled={!texto.trim()} style={{background:texto.trim()?C.green:"#ccc",color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:texto.trim()?"pointer":"default",height:34}}>+ Añadir</button>
      </div>
      {incidencias.length===0?<div style={{color:C.muted,fontSize:12,textAlign:"center",padding:"16px"}}>Sin incidencias registradas.</div>:(
        <div style={{display:"grid",gap:8}}>
          {incidencias.slice(0,15).map(inc=>{
            const t=TIPOS_INC.find(x=>x.id===inc.tipo)||TIPOS_INC.at(-1);
            return(
              <div key={inc.id} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"8px 12px",borderLeft:`3px solid ${t.color}`,background:"#fafafa",borderRadius:"0 8px 8px 0"}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:2}}>
                    <Badge color={t.color}>{t.label}</Badge>
                    <span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{inc.fecha?.replace("T"," ")}</span>
                  </div>
                  <div style={{fontSize:12}}>{inc.texto}</div>
                </div>
                <button onClick={()=>setIncidencias(prev=>prev.filter(x=>x.id!==inc.id))} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13}}>✕</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Onboarding ────────────────────────────────────────────────────
function OnboardingPanel({onCSV,onXLSX,onDemo,hasData}){
  return(
    <div style={{background:"#fff",border:"1px solid #f0f0f0",borderRadius:16,padding:"24px 28px",marginBottom:20,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>⚙️ Cargar datos SN8 — Rubí · Biológico</div>
      <div style={{fontSize:12,color:C.muted,marginBottom:16,lineHeight:1.7}}>
        Columnas requeridas: <b>Fecha · Hora · INH · AUR · Rs Max 1 · Rs Max 2</b><br/>
        Formatos: CSV (;) · Excel · Separador automático · Fechas DD/MM/YYYY o YYYY-MM-DD
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        <DropZone onFile={onCSV} accept=".csv,.txt,.xls" color={C.green} done={hasData}
          label="CSV o XLS del SN8" sublabel="Resumen2025-01-01_xxx.csv / .xls"/>
        <DropZone onFile={onCSV} onBinary={onXLSX} accept=".xlsx" color={C.blue} done={hasData}
          label="Excel real (.xlsx)" sublabel="Si exportaste desde Excel"/>
      </div>
      <div style={{display:"flex",justifyContent:"center"}}>
        <button onClick={onDemo} style={{background:`linear-gradient(135deg,${C.green},${C.blue})`,color:"#fff",border:"none",borderRadius:10,padding:"12px 32px",fontSize:13,fontWeight:700,cursor:"pointer"}}>
          🎬 Cargar demo con datos sintéticos
        </button>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────
export default function App(){
  const [data,        setData]        = useState(null);
  const [demoMode,    setDemoMode]    = useState(false);
  const [tab,         setTab]         = useState("sictox");
  const [inhUmbral,   setInhUmbral]   = useState(60);
  const [alertas,     setAlertas]     = useState(ALERT_DEF);
  const [alertasDisp, setAlertasDisp] = useState([]);
  const [dismissed,   setDismissed]   = useState(new Set());
  const [incidencias, setIncidencias] = useState([]);
  const [showOnboard, setShowOnboard] = useState(true);
  const [cfg,         setCfg]         = useState({...DEFAULTS});
  const [autoSync,    setAutoSync]    = useState(null); // fecha última sync
  const [curvas,      setCurvas]      = useState(null); // datos brutos tests
  const prevDispRef=useRef([]);
  const pred=data?predecirAUR(data.filter(d=>d.valido)):null;

  // ── Auto-carga desde data.json (MySQL sync) ───────────────────
  useEffect(()=>{
    async function cargarAuto(){
      try{
        const res=await fetch('./data.json?t='+Date.now());
        if(!res.ok) return;
        const json=await res.json();
        if(!json?.registros?.length) return;
        const rows=buildRows(json.registros, cfg);
        if(rows.length){
          setData(rows); setDemoMode(false); setShowOnboard(false);
          setAutoSync(json.generado);
        }
      }catch(e){ console.log("Auto-carga no disponible:",e.message); }
    }
    cargarAuto();
    // Refresco cada 10 minutos
    const interval=setInterval(cargarAuto, 10*60*1000);
    return ()=>clearInterval(interval);
  },[]);

  useEffect(()=>{
    if(!data) return;
    const nuevas=evaluarAlertas(alertas,data,cfg);
    setAlertasDisp(nuevas);
    nuevas.forEach(a=>{if(!prevDispRef.current.find(p=>p.id===a.id)&&!dismissed.has(a.id)&&a.sonido) playAlertTone(a.severidad==="critica"?"critical":"warning");});
    prevDispRef.current=nuevas;
  },[data,alertas,cfg]);

  const alertasVis=alertasDisp.filter(a=>!dismissed.has(a.id));

  // Parser HTML para el .xls del SN8 (que en realidad es HTML)
  const parseHTMLxls = useCallback(raw => {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(raw, "text/html");
      const tables = doc.querySelectorAll("table");
      for (const table of tables) {
        const rows = table.querySelectorAll("tr");
        let hdrIdx = -1, hdr = [];
        for (let i = 0; i < rows.length; i++) {
          const cells = [...rows[i].querySelectorAll("td,th")].map(c => c.textContent.trim());
          if (cells.some(c => c.toUpperCase() === "INH") && cells.some(c => c.toUpperCase() === "AUR")) {
            hdrIdx = i; hdr = cells; break;
          }
        }
        if (hdrIdx < 0) continue;
        const records = [];
        for (let i = hdrIdx + 1; i < rows.length; i++) {
          const cells = [...rows[i].querySelectorAll("td,th")].map(c => c.textContent.trim());
          if (!cells.some(c => c)) continue;
          const obj = {};
          hdr.forEach((h, j) => obj[h] = cells[j] ?? "");
          records.push(obj);
        }
        if (records.length) {
          const rows2 = buildRows(records, cfg);
          if (rows2.length) { setData(rows2); setDemoMode(false); setShowOnboard(false); setTab("pred"); return; }
        }
      }
      alert("No se encontró tabla de TOXICIDAD en el archivo .xls.");
    } catch(e) { alert("Error parseando el archivo: " + e.message); }
  }, [cfg]);

  const handleCSV=useCallback(raw=>{
    // Detecta si es HTML (archivo .xls del SN8)
    if (raw.trim().startsWith("<") || raw.includes("<table")) { parseHTMLxls(raw); return; }
    const rows=parseCSV(raw,cfg);
    if(!rows.length){alert("Sin datos válidos. Columnas necesarias: Fecha, Hora, INH, AUR, Rs Max 1, Rs Max 2");return;}
    setData(rows);setDemoMode(false);setShowOnboard(false);setTab("sictox");
  },[cfg, parseHTMLxls]);
  const handleXLSX=useCallback(buf=>{
    parseXLSX(buf,cfg).then(rows=>{
      if(!rows.length){alert("Sin datos válidos.");return;}
      setData(rows);setDemoMode(false);setShowOnboard(false);setTab("sictox");
    }).catch(e=>alert("Error: "+e.message));
  },[cfg]);
  const handleDemo=useCallback(()=>{
    setData(generarDemoData());setDemoMode(true);setShowOnboard(false);setTab("sictox");
  },[]);

  const TABS_SICAIR = [
    {id:"pred",      label:"🔮 Predicción",   disabled:!data},
    {id:"historico", label:"📈 Histórico AUR", disabled:!data},
    {id:"graficas",  label:"📉 Gráficas test", disabled:!data},
  ];
  const TABS_SICTOX = [
    {id:"sictox",      label:"☣️ Episodios INH",   disabled:!data, badge:alertasDisp.filter(a=>["inh_aviso","inh_critico","vertido"].includes(a.id)).length},
    {id:"riesgo",      label:"🎯 Riesgo vertido",   disabled:!data},
  ];
  const TABS_GENERAL = [
    {id:"calidad",     label:"🔬 Calidad datos",    disabled:!data},
    {id:"incidencias", label:"📋 Incidencias",      disabled:false, badge:incidencias.length},
    {id:"alertas",     label:"🔔 Alertas / Config", disabled:false, badge:alertasVis.length, badgeColor:alertasVis.some(a=>a.severidad==="critica")?C.red:C.amber},
  ];

  const isSicAir  = TABS_SICAIR.some(t=>t.id===tab);
  const isSicTox  = TABS_SICTOX.some(t=>t.id===tab);
  const accentTab = isSicTox ? C.red : isSicAir ? C.green : C.muted;

  function TabBar({tabs, accent}){
    return tabs.map(t=>(
      <button key={t.id} onClick={()=>!t.disabled&&setTab(t.id)} style={{
        background:"transparent",
        color:tab===t.id?accent:t.disabled?"#d0d0d0":C.muted,
        border:"none",
        borderBottom:tab===t.id?`2px solid ${accent}`:"2px solid transparent",
        padding:"9px 15px",fontSize:12,fontWeight:tab===t.id?700:400,
        cursor:t.disabled?"default":"pointer",transition:"all .15s",
        position:"relative",marginBottom:-1,whiteSpace:"nowrap",
      }}>
        {t.label}
        {t.badge>0&&<span style={{marginLeft:5,background:t.badgeColor||C.amber,color:"#fff",borderRadius:20,padding:"1px 6px",fontSize:9,fontWeight:700}}>{t.badge}</span>}
      </button>
    ));
  }

  return(
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"system-ui,sans-serif"}}>
      <AlertaBanner alertas={alertasVis} onDismiss={id=>setDismissed(prev=>new Set([...prev,id]))}/>

      {/* Header */}
      <div style={{background:"#fff",borderBottom:"1px solid #f0f0f0",padding:"0 32px",display:"flex",alignItems:"center",justifyContent:"space-between",height:64}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <SensaraLogo size={34}/>
          <div style={{width:1,height:24,background:"#e8e8e8"}}/>
          <div>
            <div style={{fontSize:15,fontWeight:700,letterSpacing:"-0.02em"}}>
              SIC<span style={{color:C.green}}>AIR</span>
              <span style={{color:"#d0d0d0",margin:"0 6px",fontWeight:300}}>·</span>
              <span style={{color:C.red}}>SicTox</span>
              <span style={{fontWeight:300,color:"#bbb",marginLeft:6}}>Rubí 1.0</span>
            </div>
            <div style={{fontSize:10,color:C.muted,letterSpacing:"0.03em",marginTop:1}}>EDAR Rubí · ACA</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {data&&<Badge color={C.lime}>{data.filter(d=>d.valido).length} tests válidos</Badge>}
          {autoSync&&<Badge color={C.lime}>🔄 {new Date(autoSync).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}</Badge>}
          {demoMode&&<Badge color={C.amber}>🎬 Demo</Badge>}
          {alertasDisp.length>0&&<Badge color={alertasDisp.some(a=>a.severidad==="critica")?C.red:C.amber}>🔔 {alertasDisp.length}</Badge>}
          <button onClick={()=>setShowOnboard(v=>!v)} style={{background:C.panel,color:C.muted,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 14px",fontSize:11,fontWeight:700,cursor:"pointer"}}>⚙️ Cargar</button>
        </div>
      </div>

      <div style={{padding:"24px 40px",maxWidth:1280,margin:"0 auto"}}>
        {showOnboard&&<OnboardingPanel onCSV={handleCSV} onXLSX={handleXLSX} onDemo={handleDemo} hasData={!!data}/>}
        {demoMode&&(
          <div style={{background:`linear-gradient(135deg,${C.red},${C.purple})`,borderRadius:10,padding:"10px 20px",marginBottom:14,display:"flex",alignItems:"center",gap:12,color:"#fff"}}>
            <span style={{fontSize:20}}>🎬</span>
            <div style={{flex:1,fontSize:12,fontWeight:700}}>Modo Demo — datos sintéticos · Rubí · Biológico</div>
            <button onClick={()=>{setData(null);setDemoMode(false);setShowOnboard(true);}} style={{background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.4)",color:"#fff",borderRadius:8,padding:"4px 12px",fontSize:11,fontWeight:700,cursor:"pointer"}}>✕ Salir</button>
          </div>
        )}

        {data&&<Semaforo data={data} alertasDisp={alertasDisp} cfg={cfg}/>}
        {data&&<KpisPanel data={data} pred={pred} cfg={cfg}/>}

        {/* ── Navegación SicTox / SicAir (horizontal) ── */}
        <div style={{display:"flex",gap:0,marginBottom:20,borderBottom:"1px solid #f0f0f0"}}>
          {/* Bloque SicTox */}
          <div style={{display:"flex",alignItems:"stretch",marginBottom:-1}}>
            <div style={{display:"flex",alignItems:"center",padding:"0 14px 0 2px",borderRight:`2px solid ${C.red}22`,marginRight:4}}>
              <span style={{fontSize:10,fontWeight:800,letterSpacing:"0.08em",color:C.red,textTransform:"uppercase"}}>SicTox</span>
            </div>
            <TabBar tabs={TABS_SICTOX} accent={C.red}/>
          </div>
          {/* Separador */}
          <div style={{width:1,background:"#e8e8e8",margin:"8px 10px"}}/>
          {/* Bloque SicAir */}
          <div style={{display:"flex",alignItems:"stretch",marginBottom:-1}}>
            <div style={{display:"flex",alignItems:"center",padding:"0 14px 0 4px",borderRight:`2px solid ${C.green}22`,marginRight:4}}>
              <span style={{fontSize:10,fontWeight:800,letterSpacing:"0.08em",color:C.green,textTransform:"uppercase"}}>SicAir</span>
            </div>
            <TabBar tabs={TABS_SICAIR} accent={C.green}/>
          </div>
        </div>

        {/* ── Layout principal: sidebar General + contenido ── */}
        <div style={{display:"flex",gap:0,alignItems:"flex-start"}}>

          {/* Sidebar General */}
          <div style={{
            width:160,flexShrink:0,
            background:"#fafafa",
            border:"1px solid #f0f0f0",
            borderRadius:12,
            padding:"12px 0",
            marginRight:20,
            position:"sticky",
            top:80,
          }}>
            <div style={{fontSize:9,fontWeight:800,letterSpacing:"0.1em",color:C.muted,textTransform:"uppercase",padding:"0 14px",marginBottom:8}}>General</div>
            {TABS_GENERAL.map(t=>(
              <button key={t.id} onClick={()=>!t.disabled&&setTab(t.id)} style={{
                display:"flex",alignItems:"center",justifyContent:"space-between",
                width:"100%",background:tab===t.id?"#fff":"transparent",
                color:tab===t.id?C.text:t.disabled?"#d0d0d0":C.muted,
                border:"none",
                borderLeft:tab===t.id?`3px solid ${C.muted}`:"3px solid transparent",
                padding:"8px 14px",fontSize:12,fontWeight:tab===t.id?700:400,
                cursor:t.disabled?"default":"pointer",
                textAlign:"left",transition:"all .15s",
              }}>
                <span>{t.label}</span>
                {t.badge>0&&<span style={{background:t.badgeColor||C.amber,color:"#fff",borderRadius:20,padding:"1px 6px",fontSize:9,fontWeight:700}}>{t.badge}</span>}
              </button>
            ))}
          </div>

          {/* Contenido principal */}
          <div style={{flex:1,minWidth:0}}>
            {tab==="pred"        &&data&&<PredPanel        data={data} pred={pred} cfg={cfg}/>}
            {tab==="historico"   &&data&&<HistoricoPanel   data={data} cfg={cfg}/>}
            {tab==="graficas"    &&data&&<GraficasPanel    data={data} curvas={curvas} setCurvas={setCurvas} cfg={cfg}/>}
            {tab==="sictox"      &&data&&<SicToxPanel      data={data} inhUmbral={inhUmbral} setInhUmbral={setInhUmbral} cfg={cfg}/>}
            {tab==="riesgo"      &&data&&<RiesgoPanel      data={data} cfg={cfg}/>}
            {tab==="calidad"     &&data&&<CalidadPanel     data={data} cfg={cfg}/>}
            {tab==="incidencias" &&      <IncidenciasPanel incidencias={incidencias} setIncidencias={setIncidencias}/>}
            {tab==="alertas"     &&      <AlertasPanel     alertas={alertas} setAlertas={setAlertas} disparadas={alertasDisp} cfg={cfg} setCfg={setCfg}/>}

            {!data&&!showOnboard&&(
              <div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}>
                <div style={{fontSize:48,marginBottom:16}}>🔬</div>
                <div style={{fontSize:16,fontWeight:600,marginBottom:8}}>Sin datos cargados</div>
                <button onClick={()=>setShowOnboard(true)} style={{background:C.green,color:"#fff",border:"none",borderRadius:10,padding:"10px 24px",fontSize:13,fontWeight:700,cursor:"pointer"}}>⚙️ Cargar datos SN8</button>
              </div>
            )}
          </div>
        </div>

        <div style={{marginTop:40,textAlign:"center",fontSize:11,color:"#ccc",paddingTop:24,borderTop:"1px solid #f4f4f4",display:"flex",justifyContent:"center",alignItems:"center",gap:8}}>
          <SensaraLogo size={18}/>
          <span><span style={{color:C.green,fontWeight:700}}>SENSARA</span> · sensaratech.com · Logroño, La Rioja · SicAir+SicTox Rubí 1.0</span>
        </div>
      </div>
    </div>
  );
}
