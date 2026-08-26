import './env.js';
import postgres from 'postgres';

export const sql = postgres(process.env.DATABASE_URL!, {
  max: 4,
  prepare: false,
});
