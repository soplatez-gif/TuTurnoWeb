// Calcula la huella de schema.sql en PGlite para compararla con la de Supabase
// (ejecuta tests/fingerprint.sql en Supabase y compara los hash por sección).
// Uso: node tests/fingerprint.mjs (desde backend/)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  -- Igual que Supabase: toda tabla nueva en public queda con permisos para estos roles
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`);
await db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const { rows } = await db.query(readFileSync(new URL('./fingerprint.sql', import.meta.url), 'utf8'));
for (const r of rows) console.log(r.section.padEnd(14), String(r.items).padStart(4), r.hash);
