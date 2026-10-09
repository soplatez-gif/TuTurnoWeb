// Uso: npm run test:schema (desde backend/)
// Valida backend/schema.sql en PGlite (Postgres en WASM) con un stub del esquema auth de Supabase
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const schema = readFileSync(process.argv[2], 'utf8');
const db = new PGlite();
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  ok   ', name); } else { fail++; console.log('  FALLA', name, extra); }
};
const expectError = async (name, sql, pattern) => {
  try { await db.exec(sql); check(name, false, '(no lanzó error)'); }
  catch (e) { check(name, pattern ? pattern.test(e.message) : true, e.message); }
};

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
`);

console.log('1) Cargar el esquema');
try { await db.exec(schema); check('schema.sql carga completo', true); }
catch (e) { check('schema.sql carga completo', false, e.message); process.exit(1); }

await db.exec(`
  grant usage on schema public to authenticated;
  grant select on all tables in schema public to authenticated;
  grant insert on support_tickets, data_requests to authenticated;
`);

const U = [...Array(7)].map((_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`);
await db.exec(U.map((u) => `insert into auth.users values ('${u}');`).join(''));
await db.exec(U.slice(0, 6).map((u, i) =>
  `insert into profiles (id, full_name, phone, birth_date, document_type, document_number)
   values ('${u}', 'Usuario ${i + 1}', '+5730000000${i}', '1990-01-01', 'cc', '10${i}');`).join(''));

console.log('2) Reglas de usuarios');
await expectError('menor de 18 no se registra',
  `insert into profiles (id, full_name, phone, birth_date) values ('${U[6]}', 'Menor', '+573009999999', current_date - interval '17 years')`,
  /profiles_adult/);

console.log('3) Utilidades de fecha');
const bd = (await db.query(`select add_business_days('2026-10-09', 5)::text d`)).rows[0].d;
check('5 días hábiles desde vie 9-oct (con festivo 12-oct) = 19-oct', bd === '2026-10-19', bd);
const co = (await db.query(`select to_char(cutoff_at('2026-10-15') at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') t`)).rows[0].t;
check('corte 15-oct 23:59:59 Bogotá = 16-oct 04:59:59 UTC', co === '2026-10-16 04:59:59', co);
const h = (await db.query(`select
  is_collection_hour('2026-10-14 10:00-05') mie10, is_collection_hour('2026-10-14 19:30-05') mie1930,
  is_collection_hour('2026-10-17 14:00-05') sab14, is_collection_hour('2026-10-17 15:30-05') sab1530,
  is_collection_hour('2026-10-18 10:00-05') dom, is_collection_hour('2026-10-12 10:00-05') festivo`)).rows[0];
check('horario de cobranza (L-V 7-19, sáb 8-15, nunca dom/festivo)',
  h.mie10 && !h.mie1930 && h.sab14 && !h.sab1530 && !h.dom && !h.festivo, JSON.stringify(h));

console.log('4) Términos y aceptación');
await db.exec(`
  insert into legal_documents (kind, country_code, version, effective_date, file_name, sha256, content_md, is_current) values
   ('general', null, '1.1', '2026-09-18', 'TuTurno_Terminos_Generales_v1.1.md', repeat('a', 64), '# Generales', true),
   ('country', 'CO', '2.3', '2026-09-21', 'TuTurno_TyC_Colombia_v2.3.md',     repeat('b', 64), '# Colombia', true);
`);
const prod = (await db.query(`select id, total_cop, commission_cop from chain_products`)).rows[0];
check('cadena por defecto: 300.000 con comisión de 60.000 (20 %)', Number(prod.total_cop) === 300000 && Number(prod.commission_cop) === 60000);
const chain = (await db.query(`insert into chains (product_id, frequency) values ('${prod.id}', 'weekly') returning id`)).rows[0].id;
const consent = (box, chainSql) => `
  insert into consent_records (user_id, box, ip, device_os, app_version, general_doc_id, general_doc_version, general_doc_sha256,
    country_doc_id, country_code, country_doc_version, country_doc_sha256, box_text, chain_id, frequency)
  select '${U[0]}', '${box}', '190.0.0.1', 'Android 14', '3.2.0', g.id, g.version, g.sha256, c.id, 'CO', c.version, c.sha256,
         'Texto exacto de la casilla ${box}', ${chainSql}
    from legal_documents g, legal_documents c where g.kind = 'general' and c.kind = 'country'`;
await db.exec(consent('A', 'null, null') + ';' + consent('B', 'null, null') + ';' + consent('C', `'${chain}', 'weekly'::chain_frequency`));
check('se registran las casillas A, B y C', (await db.query(`select count(*)::int n from consent_records`)).rows[0].n === 3);
await expectError('casilla C sin cadena se rechaza', consent('C', 'null, null'), /consent_c_has_chain/);
await expectError('aceptación no se puede editar', `update consent_records set ip = '1.1.1.1'`, /solo inserción/);
await expectError('aceptación no se puede borrar', `delete from consent_records`, /solo inserción/);

console.log('5) Cadena de 5');
for (let i = 0; i < 5; i++) {
  await db.exec(`insert into payout_methods (user_id, type, institution, account_identifier, holder_name, holder_document, is_default)
                 values ('${U[i]}', 'bre_b_key', 'Banco', '@llave${i}', 'Usuario ${i + 1}', '10${i}', true)`);
  await db.exec(`insert into chain_members (chain_id, user_id, turn_position, status, payout_method_id)
                 select '${chain}', '${U[i]}', ${i + 1}, 'active', id from payout_methods where user_id = '${U[i]}'`);
}
check('entran 5 participantes', (await db.query(`select count(*)::int n from chain_members`)).rows[0].n === 5);
await expectError('el sexto no entra: cadena completa',
  `insert into chain_members (chain_id, user_id) values ('${chain}', '${U[5]}')`, /completa/);
await expectError('turno repetido se rechaza',
  `update chain_members set turn_position = 1 where user_id = '${U[1]}'`, /duplicate|unique/);

await db.exec(`update chains set status = 'active', starts_on = '2026-10-15', filled_at = now() where id = '${chain}'`);
await db.exec(`
  insert into cycles (chain_id, cycle_number, recipient_member_id, cutoff_date)
  select chain_id, turn_position, id, date '2026-10-15' + (turn_position - 1) * 7 from chain_members where chain_id = '${chain}';
  insert into installments (cycle_id, payer_member_id, recipient_member_id, amount_cop)
  select cy.id, m.id, cy.recipient_member_id, 60000
    from cycles cy join chain_members m on m.chain_id = cy.chain_id and m.id <> cy.recipient_member_id;
`);
check('5 ciclos y 20 cuotas (4 por ciclo)',
  (await db.query(`select count(*)::int n from installments`)).rows[0].n === 20);
await expectError('nadie se paga a sí mismo',
  `insert into installments (cycle_id, payer_member_id, recipient_member_id, amount_cop)
   select cy.id, cy.recipient_member_id, cy.recipient_member_id, 60000 from cycles cy limit 1`, /not_self|unique/);

const inst = (await db.query(`select i.id, pm.id pm from installments i join cycles cy on cy.id = i.cycle_id
  join chain_members r on r.id = i.recipient_member_id join payout_methods pm on pm.id = r.payout_method_id
  where cy.cycle_number = 1 limit 1`)).rows[0];
await db.exec(`insert into payment_orders (installment_id, payout_method_id, destination_snapshot, amount_cop)
               values ('${inst.id}', '${inst.pm}', '{}', 60000)`);
await expectError('una sola orden de pago abierta por cuota',
  `insert into payment_orders (installment_id, payout_method_id, destination_snapshot, amount_cop) values ('${inst.id}', '${inst.pm}', '{}', 60000)`, /unique|duplicate/);
const exp = (await db.query(`select extract(epoch from expires_at - created_at)::int s from payment_orders`)).rows[0].s;
check('la orden de pago vence a los 10 minutos', exp === 600, exp);

console.log('6) Mora, garantía y bloqueo');
const late = (await db.query(`select i.id, m.user_id from installments i join chain_members m on m.id = i.payer_member_id
  join cycles cy on cy.id = i.cycle_id where cy.cycle_number = 1 and m.user_id = '${U[1]}'`)).rows[0];
await db.exec(`
  update installments set status = 'covered' where id = '${late.id}';
  insert into coverages (installment_id, amount_cop, due_by) values ('${late.id}', 60000, add_business_days('2026-10-15', 5));
  insert into delinquencies (user_id, installment_id, coverage_id, owed_cop, late_fee_cop, grace_until)
  select '${late.user_id}', '${late.id}', id, 60000, 60000 * 1250 / 10000, date '2026-10-15' + 6 from coverages;
`);
const st = (await db.query(`select status from profiles where id = '${U[1]}'`)).rows[0].status;
check('con mora abierta la cuenta queda bloqueada', st === 'blocked_delinquent', st);
const chain2 = (await db.query(`insert into chains (product_id, frequency) values ('${prod.id}', 'biweekly') returning id`)).rows[0].id;
await expectError('en mora no entra a cadenas nuevas',
  `insert into chain_members (chain_id, user_id) values ('${chain2}', '${U[1]}')`, /mora/);
check('recargo único = 7.500', (await db.query(`select late_fee_cop::int f from delinquencies`)).rows[0].f === 7500);
await expectError('no se reporta a centrales sin aviso previo',
  `update delinquencies set bureau_reported_at = now()`, /report_after_notice/);
await expectError('no se reporta antes de 20 días del aviso',
  `update delinquencies set bureau_notice_sent_at = now(), bureau_reported_at = now() + interval '10 days'`, /report_after_notice/);
await expectError('cobranza en domingo se rechaza',
  `insert into collection_contacts (delinquency_id, channel, contacted_at) select id, 'call', '2026-10-18 10:00-05' from delinquencies`, /hours/);
await db.exec(`insert into collection_contacts (delinquency_id, channel, contacted_at) select id, 'whatsapp', '2026-10-21 10:00-05' from delinquencies`);
check('cobranza en miércoles 10 a. m. se registra', true);
await db.exec(`update delinquencies set status = 'settled', paid_cop = 67500, settled_at = now()`);
check('al saldar la mora la cuenta se reactiva',
  (await db.query(`select status from profiles where id = '${U[1]}'`)).rows[0].status === 'active');

console.log('7) RLS: cada usuario ve solo lo suyo');
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${U[0]}', false);`);
check('participante ve su cadena', (await db.query(`select count(*)::int n from chains`)).rows[0].n === 1);
check('no ve la otra cadena', (await db.query(`select count(*)::int n from chains where id = '${chain2}'`)).rows[0].n === 0);
check('ve solo su perfil', (await db.query(`select count(*)::int n from profiles`)).rows[0].n === 1);
check('ve sus 4 cuotas a pagar y las 4 que recibe', (await db.query(`select count(*)::int n from installments`)).rows[0].n === 8);
const sum = (await db.query(`select receive_cop::int r, turn_position, my_turn_date::text d, members_count::int n from my_chain_summary`)).rows;
check('resumen: recibe 240.000 en su turno 1 el 15-oct', sum.length === 1 && sum[0].r === 240000 && sum[0].d === '2026-10-15', JSON.stringify(sum));
check('ve las llaves de los 5 participantes de su cadena', (await db.query(`select count(*)::int n from payout_methods_shared`)).rows[0].n === 5);
check('no lee la tabla de llaves ajena directo', (await db.query(`select count(*)::int n from payout_methods`)).rows[0].n === 1);
check('no ve códigos OTP ni evaluaciones de riesgo',
  (await db.query(`select (select count(*) from otp_challenges) + (select count(*) from risk_assessments) n`)).rows[0].n == 0);
await db.exec(`select set_config('request.jwt.claim.sub', '${U[5]}', false);`);
check('quien no participa no ve la cadena ni sus llaves',
  (await db.query(`select (select count(*) from chains) + (select count(*) from payout_methods_shared) n`)).rows[0].n == 0);
await db.exec(`reset role;`);

console.log(`\n${ok} correctas, ${fail} fallidas`);
process.exit(fail ? 1 : 0);
