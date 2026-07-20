import { readFileSync } from 'fs';
const convs = JSON.parse(readFileSync('D:/_cm_export/conversations.json','utf8'));
const c = convs.find(x=>(x.chat_messages||[]).length>2) || convs[0];
console.log('CONV name=', JSON.stringify(c.name), 'msgs=', c.chat_messages.length);
for(let i=0;i<Math.min(3,c.chat_messages.length);i++){
  console.log('=== MSG '+i+' (full) ===');
  console.log(JSON.stringify(c.chat_messages[i]).slice(0,1200));
}
