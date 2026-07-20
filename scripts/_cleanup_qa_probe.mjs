import { Pool } from 'pg';
const conn = process.argv[2];
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await pool.query(`DELETE FROM conversation_sessions WHERE id = '11111111-1111-1111-1111-111111111111'`);
await pool.query(`DELETE FROM memory_items WHERE user_id = 'troy' AND subject = 'Daughter name'`);
console.log('cleaned up QA probe data');
await pool.end();
