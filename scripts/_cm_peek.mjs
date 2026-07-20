import { readFileSync, readdirSync } from 'fs';
const dir='D:/_cm_export';
const convs = JSON.parse(readFileSync(dir+'/conversations.json','utf8'));
console.log('conv_isArray', Array.isArray(convs), 'count', convs.length);
const c0=convs[0];
console.log('conv_keys', JSON.stringify(Object.keys(c0)));
console.log('conv_sample', JSON.stringify({uuid:c0.uuid,name:c0.name,created_at:c0.created_at,updated_at:c0.updated_at,project_uuid:c0.project_uuid,hasMsgs:Array.isArray(c0.chat_messages),msgCount:(c0.chat_messages||[]).length}));
const m0=(c0.chat_messages||[])[0];
if(m0){ console.log('msg_keys', JSON.stringify(Object.keys(m0))); console.log('msg_sample', JSON.stringify({sender:m0.sender,created_at:m0.created_at,text:(m0.text||'').slice(0,60),hasContent:Array.isArray(m0.content),content0keys:(m0.content&&m0.content[0])?Object.keys(m0.content[0]):null})); }
const pfiles=readdirSync(dir+'/projects');
console.log('project_files', pfiles.length);
const p0=JSON.parse(readFileSync(dir+'/projects/'+pfiles[0],'utf8'));
console.log('project_keys', JSON.stringify(Object.keys(p0)));
const byProj={}; for(const c of convs){ const k=c.project_uuid||'(none)'; byProj[k]=(byProj[k]||0)+1; }
console.log('convs_by_project', JSON.stringify(byProj));
