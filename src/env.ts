import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Repo-root .env (DATABASE_URL, OPENAI_API_KEY).
config({ path: join(here, '..', '.env') });

export const DATABASE_URL = process.env.DATABASE_URL!;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
