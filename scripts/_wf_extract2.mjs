import { readFileSync, readdirSync } from 'fs';
const dir='C:/Users/troyh/.claude/projects/C--Users-troyh--claude/0dd9f9d2-c5ca-4e74-995c-2d9ecacf7f0b/subagents/workflows/wf_013be5ed-c26';
function findKey(o,key,d){ if(d>12||!o||typeof o!=='object') return null; if(Array.isArray(o)){ for(const x of o){ const r=findKey(x,key,d+1); if(r) return r; } return null; } if(Object.prototype.hasOwnProperty.call(o,key)) return o; for(const k of Object.keys(o)){ const r=findKey(o[k],key,d+1); if(r) return r; } return null; }
let synth=null, which=null;
for(const f of readdirSync(dir)){ if(!f.endsWith('.jsonl')) continue; const lines=readFileSync(dir+'/'+f,'utf8').split('\n').filter(Boolean); for(const ln of lines){ let o; try{o=JSON.parse(ln);}catch(e){continue;} const s=findKey(o,'biomeMapping',0); if(s && Array.isArray(s.biomeMapping)){ synth=s; which=f; break; } } if(synth) break; }
if(!synth){ console.log('NO biomeMapping found in any agent jsonl'); process.exit(0); }
console.log('FROM', which);
console.log('ROOTCAUSE:', (synth.rootCause||'').slice(0,400));
for(const b of (synth.biomeMapping||[])){ console.log('['+b.biome+']'); for(const l of (b.layers||[])){ console.log('  - '+l.layerName+' alb='+(l.albedoPath||'?')+' nrm='+(l.normalPath||'?')+' msk='+(l.maskPath||'-')+' tile='+(l.tileSize||'-')+' by='+(l.assignBy||'-')); } if(b.missing&&b.missing.length) console.log('  MISSING: '+b.missing.join('; ')); }
console.log('WATER:', (synth.waterPlan||'').slice(0,300));
console.log('ROCK:', (synth.rockPlan||'').slice(0,300));
console.log('SPEC:', (synth.scriptSpec||'').slice(0,1400));
console.log('QA:', (synth.qaPlan||'').slice(0,300));
console.log('RISKS:', JSON.stringify(synth.risks||[]).slice(0,400));
