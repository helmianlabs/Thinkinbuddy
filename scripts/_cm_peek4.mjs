import { readFileSync } from 'fs';
const m = JSON.parse(readFileSync('D:/_cm_export/memories.json','utf8'));
console.log('memories type:', Array.isArray(m)?('array len '+m.length):typeof m);
if(Array.isArray(m) && m.length){ console.log('item0 keys:', JSON.stringify(Object.keys(m[0]))); console.log('item0:', JSON.stringify(m[0]).slice(0,500)); }
else { console.log('raw head:', JSON.stringify(m).slice(0,600)); }
// users.json
try{ const u=JSON.parse(readFileSync('D:/_cm_export/users.json','utf8')); console.log('users:', JSON.stringify(u).slice(0,200)); }catch(e){ console.log('users.json:', e.message); }
