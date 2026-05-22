import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

export const DATABASE_URL = required('DATABASE_URL');
export const OPENAI_API_KEY = required('OPENAI_API_KEY');
