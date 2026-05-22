// Load env from demo_311/.env, then fall back to the parent repo's .env.
import 'dotenv/config';
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const parent = resolve(here, '../../.env');
if (existsSync(parent)) config({ path: parent, override: false });
