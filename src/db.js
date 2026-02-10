require('dotenv').config({ override: true });
const { Pool } = require('pg');

const cs = process.env.DATABASE_URL;
if (!cs) throw new Error('DATABASE_URL is missing');

const isNeon = cs.includes('.neon.tech');
const pool = new Pool({
  connectionString: cs,
  ssl: isNeon ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
