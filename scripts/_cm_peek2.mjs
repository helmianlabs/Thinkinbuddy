import { readFileSync } from 'fs';
const convs = JSON.parse(readFileSync('D:/_cm_export/conversations.json','utf8'));
let withText=0, withContent=0, total=0, sample=null, sampleText=null;
for(const c of convs){ for(const mm of (c.chat_messages||[])){ total++;
  if(mm.text && mm.text.trim()) withText++;
  if(Array.isArray(mm.content) && mm.content.length){ withContent++; if(!sample) sample=mm; }
  if(mm.text && mm.text.trim() && !sampleText) sampleText=mm;
}}
console.log('total',total,'withNonEmptyText',withText,'withContentArr',withContent);
if(sample){
  console.log('content_len', sample.content.length);
  console.log('content[0]', JSON.stringify(sample.content[0]).slice(0,500));
  if(sample.content[1]) console.log('content[1]', JSON.stringify(sample.content[1]).slice(0,300));
}
if(sampleText){ console.log('TEXT_SAMPLE', sampleText.sender, '::', sampleText.text.slice(0,120)); }
else { console.log('NO message had non-empty .text'); }
