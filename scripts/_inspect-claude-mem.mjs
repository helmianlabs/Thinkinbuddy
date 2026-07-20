import { Pool } from 'pg';
import { readFileSync } from 'fs';
const raw = readFileSync('C:/Users/troyh/.claude.json','utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\]+neon\.tech\/neondb[^"'\s\]*/);
if(!m){ console.error('NO_NEON_STRING'); process.exit(1); }
const base = m[0].replace(/\u0026/g,'&');
const connFor = (db)=> base.replace(/\/neondb(\?|$)/, '/'+db+'$1');
const p0 = new Pool({ connectionString: base, ssl:{rejectUnauthorized:false}, max:2 });
const dbs = (await p0.query("select datname from pg_database where datistemplate=false order by datname")).rows.map(r=>r.datname);
console.log('DATABASES:', dbs.join(', '));
await p0.end();
const target = dbs.find(d=>/claude/i.test(d)) || dbs.find(d=>/memor/i.test(d) && !/thinkin/i.test(d));
console.log('TARGET:', target||'(none)');
if(target){
  const p = new Pool({ connectionString: connFor(target), ssl:{rejectUnauthorized:false}, max:2 });
  const tabs = (await p.query("select table_name from information_schema.tables where table_schema='public' order by table_name")).rows.map(r=>r.table_name);
  console.log('TABLES:', tabs.join(', '));
  for(const t of tabs){
    const cols = (await p.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",[t])).rows;
    let n='?'; try{ n=(await p.query('select count(*)::int n from "'+t+'"')).rows[0].n; }catch(e){ n='ERR'; }
    console.log('--- '+t+' (rows='+n+'): '+cols.map(c=>c.column_name+':'+c.data_type).join(', '));
  }
  await p.end();
}
