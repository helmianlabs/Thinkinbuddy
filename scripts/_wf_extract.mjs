import { readFileSync } from 'fs';
const J='C:/Users/troyh/.claude/projects/C--Users-troyh--claude/0dd9f9d2-c5ca-4e74-995c-2d9ecacf7f0b/subagents/workflows/wf_013be5ed-c26/journal.jsonl';
const lines=readFileSync(J,'utf8').split('\n').filter(Boolean);
function findKey(obj,key,depth){ if(depth>8||!obj||typeof obj!=='object') return null; if(Object.prototype.hasOwnProperty.call(obj,key)) return obj; for(const k of Object.keys(obj)){ const r=findKey(obj[k],key,depth+1); if(r) return r; } return null; }
let synth=null, scene=null;
for(const ln of lines){ let o; try{o=JSON.parse(ln);}catch(e){continue;}
  if(!synth){ const s=findKey(o,'biomeMapping',0); if(s) synth=s; }
  if(!scene){ const s=findKey(o,'tiles',0); if(s && s.rootCause) scene=s; }
}
if(scene){ console.log('SCENE ROOT CAUSE:', scene.rootCause); }
if(!synth){ console.log('NO SYNTH RESULT in journal'); process.exit(0); }
console.log('\nSYNTH ROOT CAUSE:', synth.rootCause);
console.log('\nBIOMES:');
for(const b of (synth.biomeMapping||[])){
  console.log('  ['+b.biome+']');
  for(const l of (b.layers||[])){ console.log('    - '+l.layerName+' | albedo='+(l.albedoPath||'?')+' | normal='+(l.normalPath||'?')+' | mask='+(l.maskPath||'-')+' | tile='+(l.tileSize||'-')+' | by='+(l.assignBy||'-')); }
  if(b.missing&&b.missing.length) console.log('    MISSING: '+b.missing.join('; '));
}
console.log('\nWATER PLAN:', (synth.waterPlan||'').slice(0,400));
console.log('\nROCK PLAN:', (synth.rockPlan||'').slice(0,400));
console.log('\nSCRIPT SPEC:', (synth.scriptSpec||'').slice(0,1500));
console.log('\nQA PLAN:', (synth.qaPlan||'').slice(0,400));
console.log('\nRISKS:', JSON.stringify(synth.risks||[]));
