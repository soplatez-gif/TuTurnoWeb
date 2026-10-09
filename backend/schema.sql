-- =====================================================================
-- TuTurno · Motor de la app · Esquema de base de datos (PostgreSQL / Supabase)
-- =====================================================================
-- Fuente de las reglas: TyC Colombia v2.3 (21-sep-2026), Términos Generales
-- v1.1 y Manual de Implementación TyC v1.3. Las cláusulas se citan en los
-- comentarios para poder rastrear cada regla hasta el contrato.
--
-- Principios del modelo:
--   * TuTurno NO capta ni custodia plata (cl. 1): las cuotas van directo entre
--     participantes. La base solo registra órdenes, comprobantes y estados.
--   * Lo único que TuTurno cobra es la comisión de servicio (Stripe) y, a quien
--     cae en mora, la cuota cubierta más el recargo (cl. 7).
--   * Montos en pesos colombianos enteros (bigint, sin decimales).
--   * Fechas de corte a las 11:59:59 p. m. hora Colombia (America/Bogota).
--   * Las aceptaciones de términos son de solo inserción (Manual §5).
--
-- Supabase: los usuarios viven en auth.users; profiles extiende esa tabla.
-- Las rutas de la API usan service_role (que salta RLS); las políticas RLS
-- cubren las lecturas directas desde la app con el rol authenticated.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type document_type        as enum ('cc', 'ce', 'passport', 'ppt');        -- cédula, cédula de extranjería, pasaporte, PPT
create type kyc_status           as enum ('pending', 'in_review', 'approved', 'rejected');
create type account_status       as enum ('active', 'blocked_delinquent', 'suspended', 'closed');
create type payout_method_type   as enum ('bre_b_key', 'bank_account', 'wallet');
create type chain_frequency      as enum ('weekly', 'biweekly');                  -- semanal, quincenal
create type chain_status         as enum ('forming', 'active', 'completed', 'cancelled_unfilled', 'cancelled');
create type member_status        as enum ('pending_commission', 'pending_kyc', 'active', 'withdrawn', 'removed');
create type installment_status   as enum ('pending', 'proof_uploaded', 'confirmed', 'rejected', 'overdue', 'covered');
create type payment_order_status as enum ('open', 'expired', 'used', 'cancelled');
create type commission_status    as enum ('pending', 'paid', 'failed', 'refunded', 'credited');
create type refund_reason        as enum ('withdrawal_5_business_days', 'chain_not_filled', 'tuturno_fault');
create type refund_method        as enum ('card_refund', 'credit');
create type coverage_status      as enum ('open', 'partially_covered', 'covered', 'late');
create type coverage_source      as enum ('new_user_commission', 'delinquent_payment', 'tuturno_funds');
create type delinquency_status   as enum ('grace', 'collection', 'notice_sent', 'reported', 'settled');
create type consent_box          as enum ('A', 'B', 'C');
create type legal_doc_kind       as enum ('general', 'country');
create type guarantor_status     as enum ('pending_code', 'confirmed', 'rejected', 'expired', 'charged');
create type contact_channel      as enum ('sms', 'whatsapp', 'call', 'email', 'push');
create type request_status       as enum ('open', 'in_progress', 'resolved', 'rejected');
create type data_request_kind    as enum ('access', 'update', 'delete', 'revoke');

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Festivos de Colombia: los usa el cálculo de días hábiles (garantía de 5
-- días hábiles, retracto de 5 días hábiles, PQR y reembolsos de 15).
create table co_holidays (
  day  date primary key,
  name text not null
);

-- Suma n días hábiles (lunes a viernes, sin festivos) a una fecha.
create or replace function add_business_days(start_day date, n int) returns date
language plpgsql stable as $$
declare
  d date := start_day;
  added int := 0;
begin
  while added < n loop
    d := d + 1;
    if extract(isodow from d) < 6 and not exists (select 1 from co_holidays h where h.day = d) then
      added := added + 1;
    end if;
  end loop;
  return d;
end $$;

-- Fecha de corte → instante exacto: 11:59:59 p. m. hora Colombia (cl. 7).
create or replace function cutoff_at(day date) returns timestamptz
language sql immutable as $$
  select (day + time '23:59:59') at time zone 'America/Bogota'
$$;

-- ---------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------
-- Requisitos (cl. 2 y 5.1): mayor de 18, residente en Colombia, documento
-- vigente, cuentas o llaves a su nombre.
create table profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  full_name        text not null,
  phone            text not null unique,
  email            text unique,
  country_code     char(2) not null default 'CO',          -- define qué TyC por país se muestran (Manual §2.2)
  birth_date       date not null,
  document_type    document_type,
  document_number  text,
  kyc_status       kyc_status not null default 'pending',
  status           account_status not null default 'active',
  two_factor_enabled boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint profiles_adult check (birth_date <= (current_date - interval '18 years')::date),
  constraint profiles_document unique (document_type, document_number)
);
create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

-- Verificación de identidad (documento + selfie + prueba de vida). Requiere la
-- casilla B de biométricos; sin ella no se puede activar la cuenta (Manual §3.6).
create table kyc_verifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles (id) on delete cascade,
  provider         text not null,                           -- proveedor externo de KYC
  provider_ref     text,
  document_type    document_type not null,
  document_number  text not null,
  liveness_passed  boolean,
  face_match_score numeric(5, 4),
  status           kyc_status not null default 'pending',
  rejection_reason text,
  biometric_consent_id uuid,                                -- registro de la casilla B (se enlaza abajo)
  created_at       timestamptz not null default now(),
  decided_at       timestamptz
);
create index kyc_verifications_user on kyc_verifications (user_id, created_at desc);

-- Dónde recibe el usuario su turno: llave Bre-B, cuenta o billetera, siempre
-- a su nombre (cl. 3). El titular se valida contra el documento del perfil.
create table payout_methods (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references profiles (id) on delete cascade,
  type                  payout_method_type not null,
  institution           text,                               -- banco o billetera
  account_identifier    text not null,                      -- llave Bre-B o número de cuenta
  holder_name           text not null,
  holder_document       text not null,
  is_default            boolean not null default false,
  verified_at           timestamptz,
  disabled_at           timestamptz,
  created_at            timestamptz not null default now()
);
-- Un solo medio de recibo por defecto por usuario
create unique index payout_methods_one_default on payout_methods (user_id) where is_default and disabled_at is null;

-- Códigos de un solo uso: 2FA al iniciar sesión y al cambiar datos de pago
-- (auditoría de la app, §3), y código de confirmación del respaldo (cl. 5.5).
create table otp_challenges (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles (id) on delete cascade,
  purpose       text not null check (purpose in ('login', 'payout_change', 'guarantor_confirmation')),
  channel       contact_channel not null,
  destination   text not null,                              -- número al que se envió
  code_hash     text not null,                              -- nunca el código en claro
  message_text  text,                                       -- texto íntegro enviado (Manual §4.3)
  sent_at       timestamptz not null default now(),
  expires_at    timestamptz not null,
  attempts      int not null default 0 check (attempts <= 5),
  consumed_at   timestamptz,
  result        text check (result in ('ok', 'wrong_code', 'expired', 'too_many_attempts'))
);
create index otp_challenges_user on otp_challenges (user_id, purpose, sent_at desc);

-- Evaluación de riesgo automatizada que asigna el orden de los turnos
-- (metadatos del celular y comportamiento de pago). El usuario puede pedir
-- revisión humana (ver turn_review_requests).
create table risk_assessments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles (id) on delete cascade,
  score          numeric(6, 3) not null,                    -- mayor = más cumplido
  model_version  text not null,
  inputs_summary jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index risk_assessments_user on risk_assessments (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Términos y aceptación (Manual de implementación §2 y §5)
-- ---------------------------------------------------------------------
create table legal_documents (
  id             uuid primary key default gen_random_uuid(),
  kind           legal_doc_kind not null,
  country_code   char(2),                                   -- null para los Generales
  version        text not null,
  effective_date date not null,
  file_name      text not null,
  sha256         char(64) not null,
  content_md     text not null,                             -- la app renderiza el Markdown
  is_current     boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint legal_documents_country check ((kind = 'general') = (country_code is null)),
  unique (kind, country_code, version)
);
create unique index legal_documents_current
  on legal_documents (kind, coalesce(country_code, '--')) where is_current;

-- Cada casilla marcada genera un registro inmutable: solo inserción.
create table consent_records (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references profiles (id),
  box                 consent_box not null,
  accepted_at         timestamptz not null default date_trunc('second', now()),
  ip                  inet not null,
  device_os           text not null,
  app_version         text not null,
  device_model        text,
  general_doc_id      uuid not null references legal_documents (id),
  general_doc_version text not null,
  general_doc_sha256  char(64) not null,
  country_doc_id      uuid not null references legal_documents (id),
  country_code        char(2) not null,
  country_doc_version text not null,
  country_doc_sha256  char(64) not null,
  box_text            text not null,                        -- texto exacto tal como se mostró
  chain_id            uuid,                                 -- solo casilla C (FK más abajo)
  frequency           chain_frequency,                      -- solo casilla C
  constraint consent_c_has_chain check ((box = 'C') = (chain_id is not null and frequency is not null))
);
create index consent_records_user on consent_records (user_id, accepted_at desc);

alter table kyc_verifications
  add constraint kyc_biometric_consent_fk foreign key (biometric_consent_id) references consent_records (id);

create or replace function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'La tabla % es de solo inserción', tg_table_name;
end $$;
create trigger consent_records_immutable before update or delete on consent_records
  for each row execute function forbid_change();

-- ---------------------------------------------------------------------
-- Cadenas
-- ---------------------------------------------------------------------
-- Plantilla configurable. Hoy hay una por defecto: 300.000 COP, 5 cupos,
-- cuota de 60.000, semanal o quincenal (cl. "La cadena").
create table chain_products (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  country_code         char(2) not null default 'CO',
  participants         int not null default 5 check (participants = 5),  -- cl.: 5 participantes, siempre
  installment_cop      bigint not null check (installment_cop > 0),
  total_cop            bigint generated always as (installment_cop * participants) stored,
  frequencies          chain_frequency[] not null default '{weekly,biweekly}',
  commission_cop       bigint not null,                     -- una cuota = 20 % del total (cl. 4)
  late_fee_bps         int not null default 1250,           -- recargo único 12,5 % de la cuota (cl. 7)
  grace_days           int not null default 6,              -- días calendario antes de la cobranza
  fill_deadline_days   int not null default 10,             -- si no se llena en 10 días, se reembolsa (cl. 4.4)
  coverage_business_days int not null default 5,            -- garantía: máximo 5 días hábiles (cl. 3.5)
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  constraint chain_products_commission check (commission_cop = installment_cop)
);

-- Una cadena concreta (el grupo de 5).
create table chains (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references chain_products (id),
  frequency         chain_frequency not null,
  status            chain_status not null default 'forming',
  fill_deadline_at  timestamptz not null default now() + interval '10 days',
  starts_on         date,                                   -- primera fecha de corte
  filled_at         timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chains_start_when_active check (status in ('forming', 'cancelled_unfilled', 'cancelled') or starts_on is not null)
);
create index chains_forming on chains (product_id, frequency) where status = 'forming';
create trigger chains_updated_at before update on chains
  for each row execute function set_updated_at();

alter table consent_records
  add constraint consent_records_chain_fk foreign key (chain_id) references chains (id);

-- Participantes. El turno no se elige ni se sortea: lo asigna la evaluación
-- de riesgo al llenarse la cadena (turn_position queda null mientras tanto).
create table chain_members (
  id                  uuid primary key default gen_random_uuid(),
  chain_id            uuid not null references chains (id) on delete cascade,
  user_id             uuid not null references profiles (id),
  turn_position       int check (turn_position between 1 and 5),
  risk_assessment_id  uuid references risk_assessments (id),
  payout_method_id    uuid references payout_methods (id),  -- dónde recibe su turno
  status              member_status not null default 'pending_commission',
  joined_at           timestamptz not null default now(),
  withdrawn_at        timestamptz,
  unique (chain_id, user_id),
  unique (chain_id, turn_position)
);
create index chain_members_user on chain_members (user_id);

-- No se puede entrar a una cadena llena, ni estando en mora (cl. 7).
create or replace function check_chain_member_insert() returns trigger
language plpgsql as $$
declare
  cap int;
  taken int;
begin
  select p.participants into cap
    from chains c join chain_products p on p.id = c.product_id
   where c.id = new.chain_id and c.status = 'forming'
   for update of c;
  if cap is null then
    raise exception 'La cadena no está recibiendo participantes';
  end if;

  select count(*) into taken from chain_members
   where chain_id = new.chain_id and status not in ('withdrawn', 'removed');
  if taken >= cap then
    raise exception 'La cadena ya está completa';
  end if;

  if exists (select 1 from profiles where id = new.user_id and status <> 'active') then
    raise exception 'La cuenta no puede entrar a cadenas nuevas (mora o suspensión)';
  end if;
  return new;
end $$;
create trigger chain_members_check before insert on chain_members
  for each row execute function check_chain_member_insert();

-- Revisión humana de la asignación del turno.
create table turn_review_requests (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references chain_members (id) on delete cascade,
  reason        text not null,
  status        request_status not null default 'open',
  resolution    text,
  reviewed_by   uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Respaldo: una persona mayor de edad que acepta con un código y responde por
-- una sola cuota (cl. 5.5).
create table guarantors (
  id               uuid primary key default gen_random_uuid(),
  member_id        uuid not null references chain_members (id) on delete cascade,
  full_name        text not null,
  phone            text not null,
  document_type    document_type not null,
  document_number  text not null,
  otp_challenge_id uuid references otp_challenges (id),     -- texto, número, envío e ingreso del código
  status           guarantor_status not null default 'pending_code',
  max_liability_cop bigint not null,                        -- una cuota
  confirmed_at     timestamptz,
  created_at       timestamptz not null default now()
);
create unique index guarantors_one_active on guarantors (member_id) where status in ('pending_code', 'confirmed');

-- ---------------------------------------------------------------------
-- Comisión de servicio (cl. 4): Stripe, una vez por cadena, por adelantado
-- ---------------------------------------------------------------------
create table commissions (
  id                       uuid primary key default gen_random_uuid(),
  member_id                uuid not null unique references chain_members (id),
  user_id                  uuid not null references profiles (id),
  amount_cop               bigint not null check (amount_cop > 0),
  status                   commission_status not null default 'pending',
  stripe_payment_intent_id text unique,
  stripe_failure_code      text,                            -- motivo del rechazo (57 % de rechazos, S38)
  paid_with_credit_id      uuid,                            -- si se pagó con un crédito previo
  -- Caso 2 del enrutador de la garantía: la comisión del usuario nuevo se paga
  -- directo a la llave del afectado (cl. 3.5). Aquí queda a qué cobertura fue.
  routed_to_coverage_id    uuid,
  paid_at                  timestamptz,
  created_at               timestamptz not null default now()
);

create table commission_refunds (
  id               uuid primary key default gen_random_uuid(),
  commission_id    uuid not null references commissions (id),
  reason           refund_reason not null,
  method           refund_method not null,
  amount_cop       bigint not null check (amount_cop > 0),
  due_by           date not null,                           -- 15 días hábiles (cl. 4.4)
  stripe_refund_id text unique,
  status           request_status not null default 'open',
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

-- Crédito para otra cadena cuando la cadena no se llena (cl. 4.4 b).
create table user_credits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles (id),
  refund_id     uuid not null unique references commission_refunds (id),
  amount_cop    bigint not null check (amount_cop > 0),
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
alter table commissions
  add constraint commissions_credit_fk foreign key (paid_with_credit_id) references user_credits (id);

-- ---------------------------------------------------------------------
-- Ciclos, cuotas y pagos entre participantes (cl. 3 y 10)
-- ---------------------------------------------------------------------
-- Un ciclo por turno: en el ciclo n recibe quien tiene turn_position = n.
create table cycles (
  id                 uuid primary key default gen_random_uuid(),
  chain_id           uuid not null references chains (id) on delete cascade,
  cycle_number       int not null check (cycle_number between 1 and 5),
  recipient_member_id uuid not null references chain_members (id),
  cutoff_date        date not null,
  cutoff_at          timestamptz generated always as (cutoff_at(cutoff_date)) stored,
  completed_at       timestamptz,                           -- el receptor tiene todas las cuotas
  unique (chain_id, cycle_number),
  unique (chain_id, recipient_member_id)
);

-- Lo que cada participante le debe al receptor del ciclo (4 cuotas por ciclo).
-- Cada participante pone 5 cuotas en total: 4 transferencias a los demás y,
-- en su propio turno, su cuota se queda con él. Por eso recibe el total de la
-- cadena (5 cuotas = 300.000) y aquí solo se registran las 4 que se mueven.
-- La comisión del 20 % va aparte, a TuTurno (tabla commissions).
create table installments (
  id                 uuid primary key default gen_random_uuid(),
  cycle_id           uuid not null references cycles (id) on delete cascade,
  payer_member_id    uuid not null references chain_members (id),
  recipient_member_id uuid not null references chain_members (id),
  amount_cop         bigint not null check (amount_cop > 0),
  status             installment_status not null default 'pending',
  confirmed_at       timestamptz,
  confirmed_by       uuid references auth.users (id),       -- el receptor o soporte
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (cycle_id, payer_member_id),
  constraint installments_not_self check (payer_member_id <> recipient_member_id)
);
create index installments_payer on installments (payer_member_id, status);
create index installments_open on installments (status) where status in ('pending', 'proof_uploaded', 'overdue');
create trigger installments_updated_at before update on installments
  for each row execute function set_updated_at();

-- Orden de pago: muestra a quién y cuánto pagar. Dura 10 minutos; si vence
-- sale otra y eso no es mora (cl. 10).
create table payment_orders (
  id                   uuid primary key default gen_random_uuid(),
  installment_id       uuid not null references installments (id) on delete cascade,
  payout_method_id     uuid not null references payout_methods (id),
  destination_snapshot jsonb not null,                      -- llave/cuenta y titular tal como se mostraron
  amount_cop           bigint not null check (amount_cop > 0),
  status               payment_order_status not null default 'open',
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null default now() + interval '10 minutes'
);
create unique index payment_orders_one_open on payment_orders (installment_id) where status = 'open';

-- Comprobante que carga el usuario tras pagar por Bre-B o transferencia.
create table payment_proofs (
  id                uuid primary key default gen_random_uuid(),
  installment_id    uuid not null references installments (id) on delete cascade,
  payment_order_id  uuid references payment_orders (id),
  storage_path      text not null,                          -- Supabase Storage, bucket privado
  bank_reference    text,
  uploaded_by       uuid not null references profiles (id),
  uploaded_at       timestamptz not null default now(),
  review_status     request_status not null default 'open',
  review_note       text
);
create index payment_proofs_installment on payment_proofs (installment_id);

-- ---------------------------------------------------------------------
-- Garantía de continuidad del turno (cl. 1.4, 1.5 y 3.5)
-- ---------------------------------------------------------------------
-- Si una cuota no llega, TuTurno completa el turno en máximo 5 días hábiles
-- desde la fecha de corte. No es seguro, ni fianza, ni genera rendimiento.
create table coverages (
  id              uuid primary key default gen_random_uuid(),
  installment_id  uuid not null unique references installments (id),
  amount_cop      bigint not null check (amount_cop > 0),
  due_by          date not null,                            -- corte + 5 días hábiles
  status          coverage_status not null default 'open',
  created_at      timestamptz not null default now(),
  covered_at      timestamptz
);

-- De dónde salió la plata, en el orden del contrato: comisiones de usuarios
-- nuevos → lo que pague el moroso → recursos propios de TuTurno.
create table coverage_allocations (
  id             uuid primary key default gen_random_uuid(),
  coverage_id    uuid not null references coverages (id) on delete cascade,
  source         coverage_source not null,
  commission_id  uuid references commissions (id),
  amount_cop     bigint not null check (amount_cop > 0),
  proof_path     text,
  created_at     timestamptz not null default now(),
  constraint coverage_allocations_source check ((source = 'new_user_commission') = (commission_id is not null))
);
alter table commissions
  add constraint commissions_coverage_fk foreign key (routed_to_coverage_id) references coverages (id);

-- ---------------------------------------------------------------------
-- Mora y cobranza (cl. 7 y Anexo 1)
-- ---------------------------------------------------------------------
create table delinquencies (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles (id),
  installment_id    uuid not null unique references installments (id),
  coverage_id       uuid references coverages (id),
  owed_cop          bigint not null check (owed_cop > 0),   -- la cuota que TuTurno cubrió
  late_fee_cop      bigint not null check (late_fee_cop >= 0), -- recargo único 12,5 %, sin intereses
  paid_cop          bigint not null default 0 check (paid_cop >= 0),
  grace_until       date not null,                          -- corte + 6 días calendario
  status            delinquency_status not null default 'grace',
  bureau_notice_sent_at timestamptz,                        -- aviso previo de 20 días
  bureau_reported_at    timestamptz,
  settled_at        timestamptz,
  created_at        timestamptz not null default now(),
  constraint delinquencies_report_after_notice check (
    bureau_reported_at is null
    or (bureau_notice_sent_at is not null and bureau_reported_at >= bureau_notice_sent_at + interval '20 days'))
);
create index delinquencies_open on delinquencies (user_id) where status <> 'settled';

-- Mientras haya mora abierta, la cuenta no entra a cadenas nuevas (cl. 7).
create or replace function sync_delinquent_status() returns trigger
language plpgsql as $$
declare
  uid uuid := coalesce(new.user_id, old.user_id);
begin
  if exists (select 1 from delinquencies where user_id = uid and status <> 'settled') then
    update profiles set status = 'blocked_delinquent' where id = uid and status = 'active';
  else
    update profiles set status = 'active' where id = uid and status = 'blocked_delinquent';
  end if;
  return null;
end $$;
create trigger delinquencies_sync_profile after insert or update of status or delete on delinquencies
  for each row execute function sync_delinquent_status();

-- Cada contacto de cobranza queda registrado. Horario permitido: lunes a
-- viernes 7 a. m.-7 p. m., sábados 8 a. m.-3 p. m.; nunca domingos ni
-- festivos (cl. 7.7). Las notificaciones automáticas de pago no son cobranza.
create or replace function is_collection_hour(t timestamptz) returns boolean
language sql stable as $$
  with l as (select (t at time zone 'America/Bogota') as ts)
  select case
    when exists (select 1 from co_holidays h, l where h.day = l.ts::date) then false
    when extract(isodow from l.ts) between 1 and 5 then l.ts::time >= '07:00' and l.ts::time < '19:00'
    when extract(isodow from l.ts) = 6 then l.ts::time >= '08:00' and l.ts::time < '15:00'
    else false
  end
  from l
$$;

create table collection_contacts (
  id              uuid primary key default gen_random_uuid(),
  delinquency_id  uuid not null references delinquencies (id) on delete cascade,
  channel         contact_channel not null,
  contacted_at    timestamptz not null default now(),
  agent_id        uuid references auth.users (id),
  outcome         text,
  constraint collection_contacts_hours check (is_collection_hour(contacted_at))
);

-- ---------------------------------------------------------------------
-- Atención: PQR (15 días hábiles) y derechos de datos (Ley 1581)
-- ---------------------------------------------------------------------
create table support_tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles (id),
  chain_id    uuid references chains (id),
  subject     text not null,
  body        text not null,
  status      request_status not null default 'open',
  due_by      date not null,                                -- 15 días hábiles
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

-- Incluye "eliminar cuenta", que hoy solo se puede pedir por correo.
create table data_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles (id),
  kind        data_request_kind not null,
  detail      text,
  status      request_status not null default 'open',
  due_by      date not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

-- Recordatorios y avisos (fecha de turno, cuota próxima a vencer, etc.)
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles (id) on delete cascade,
  channel     contact_channel not null,
  template    text not null,                                -- plantilla de respond.io
  payload     jsonb not null default '{}',
  sent_at     timestamptz,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user on notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Vistas
-- ---------------------------------------------------------------------
-- Lo que la app muestra de cada cadena: cuánto pones, cuánto recibes y, cuando
-- la cadena se llena y se asignan los turnos, en qué fecha te toca.
create view my_chain_summary with (security_invoker = true) as
select
  m.user_id,
  c.id               as chain_id,
  c.status           as chain_status,
  c.frequency,
  p.installment_cop,
  p.total_cop,
  p.total_cop        as receive_cop,                       -- recibes las 5 cuotas: las 4 de los demás + la tuya
  m.turn_position,
  cy.cutoff_date     as my_turn_date,
  (select count(*) from chain_members x
    where x.chain_id = c.id and x.status not in ('withdrawn', 'removed')) as members_count,
  p.participants
from chain_members m
join chains c          on c.id = m.chain_id
join chain_products p  on p.id = c.product_id
left join cycles cy    on cy.chain_id = c.id and cy.recipient_member_id = m.id
where m.user_id = auth.uid();

-- ---------------------------------------------------------------------
-- Seguridad a nivel de fila (Supabase)
-- ---------------------------------------------------------------------
alter table profiles              enable row level security;
alter table kyc_verifications     enable row level security;
alter table payout_methods        enable row level security;
alter table otp_challenges        enable row level security;
alter table risk_assessments      enable row level security;
alter table legal_documents       enable row level security;
alter table consent_records       enable row level security;
alter table chain_products        enable row level security;
alter table chains                enable row level security;
alter table chain_members         enable row level security;
alter table turn_review_requests  enable row level security;
alter table guarantors            enable row level security;
alter table commissions           enable row level security;
alter table commission_refunds    enable row level security;
alter table user_credits          enable row level security;
alter table cycles                enable row level security;
alter table installments          enable row level security;
alter table payment_orders        enable row level security;
alter table payment_proofs        enable row level security;
alter table coverages             enable row level security;
alter table coverage_allocations  enable row level security;
alter table delinquencies         enable row level security;
alter table collection_contacts   enable row level security;
alter table support_tickets       enable row level security;
alter table data_requests         enable row level security;
alter table notifications         enable row level security;
alter table co_holidays           enable row level security;

-- ¿El usuario actual participa en esta cadena? (security definer para no
-- entrar en recursión con la política de chain_members)
create or replace function is_chain_participant(target_chain uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from chain_members
     where chain_id = target_chain and user_id = auth.uid() and status not in ('withdrawn', 'removed'))
$$;

-- Catálogo público
create policy legal_documents_read  on legal_documents  for select using (true);
create policy chain_products_read   on chain_products   for select using (is_active);
create policy co_holidays_read      on co_holidays      for select using (true);

-- Lo propio
create policy profiles_own          on profiles          for select using (id = auth.uid());
create policy profiles_own_update   on profiles          for update using (id = auth.uid())
  with check (id = auth.uid());
create policy kyc_own               on kyc_verifications for select using (user_id = auth.uid());
create policy payout_own            on payout_methods    for select using (user_id = auth.uid());
create policy consent_own_read      on consent_records   for select using (user_id = auth.uid());
create policy commissions_own       on commissions       for select using (user_id = auth.uid());
create policy credits_own           on user_credits      for select using (user_id = auth.uid());
create policy delinquencies_own     on delinquencies     for select using (user_id = auth.uid());
create policy tickets_own           on support_tickets   for select using (user_id = auth.uid());
create policy tickets_own_insert    on support_tickets   for insert with check (user_id = auth.uid());
create policy data_requests_own     on data_requests     for select using (user_id = auth.uid());
create policy data_requests_insert  on data_requests     for insert with check (user_id = auth.uid());
create policy notifications_own     on notifications     for select using (user_id = auth.uid());

-- Lo de las cadenas en las que participa
create policy chains_participant    on chains            for select using (is_chain_participant(id));
create policy members_participant   on chain_members     for select using (is_chain_participant(chain_id));
create policy cycles_participant    on cycles            for select using (is_chain_participant(chain_id));
create policy installments_party    on installments      for select using (
  exists (select 1 from chain_members m
           where m.user_id = auth.uid() and m.id in (installments.payer_member_id, installments.recipient_member_id)));
create policy orders_payer          on payment_orders    for select using (
  exists (select 1 from installments i join chain_members m on m.id = i.payer_member_id
           where i.id = payment_orders.installment_id and m.user_id = auth.uid()));
create policy proofs_party          on payment_proofs    for select using (
  exists (select 1 from installments i join chain_members m on m.id in (i.payer_member_id, i.recipient_member_id)
           where i.id = payment_proofs.installment_id and m.user_id = auth.uid()));
create policy reviews_own           on turn_review_requests for select using (
  exists (select 1 from chain_members m where m.id = turn_review_requests.member_id and m.user_id = auth.uid()));
create policy guarantors_own        on guarantors        for select using (
  exists (select 1 from chain_members m where m.id = guarantors.member_id and m.user_id = auth.uid()));

-- Datos de pago: solo los participantes de la misma cadena (cl. 8). Se
-- exponen por la vista payout_methods_shared, no por la tabla.
create view payout_methods_shared with (security_invoker = false) as
select distinct pm.id, pm.user_id, pm.type, pm.institution, pm.account_identifier, pm.holder_name, m.chain_id
  from payout_methods pm
  join chain_members m on m.payout_method_id = pm.id
 where pm.disabled_at is null
   and is_chain_participant(m.chain_id);

-- Tablas sin política para authenticated (otp_challenges, risk_assessments,
-- coverages, coverage_allocations, collection_contacts, commission_refunds)
-- quedan cerradas: solo las toca la API con service_role.

-- Supabase da acceso a anon (sin sesión) a toda tabla nueva. RLS ya lo frena,
-- pero se quita explícitamente: anon solo lee el catálogo público.
revoke all on all tables in schema public from anon;
grant select on legal_documents, chain_products, co_holidays to anon;
-- La app con sesión solo lee (las escrituras pasan por la API), salvo las
-- solicitudes que el usuario crea directamente.
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
grant insert on support_tickets, data_requests to authenticated;
-- Solo nombre y correo: estado, verificación y teléfono se cambian por la API.
grant update (full_name, email) on profiles to authenticated;

-- ---------------------------------------------------------------------
-- Datos iniciales
-- ---------------------------------------------------------------------
insert into chain_products (name, installment_cop, commission_cop)
values ('Cadena 300.000', 60000, 60000);

insert into co_holidays (day, name) values
  ('2026-10-12', 'Día de la Raza'),
  ('2026-11-02', 'Todos los Santos'),
  ('2026-11-16', 'Independencia de Cartagena'),
  ('2026-12-08', 'Inmaculada Concepción'),
  ('2026-12-25', 'Navidad');
