import { Pool } from 'pg';
const conn = process.argv[2];
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await pool.query(`DELETE FROM conversation_sessions WHERE id = '22222222-2222-2222-2222-222222222222'`);
console.log('cleaned up prod smoke-test session');
await pool.end();
