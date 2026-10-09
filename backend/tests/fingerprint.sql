-- Huella del esquema public: sirve para comparar dos bases (p. ej. PGlite y Supabase)
select section, count(*) as items, md5(string_agg(item, E'\n' order by item)) as hash
from (
  select 'columns' as section, table_name || '.' || column_name || ':' || udt_name || ':' || is_nullable || ':' || coalesce(column_default, '') as item
    from information_schema.columns where table_schema = 'public'
  union all
  select 'constraints', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
    from pg_constraint where connamespace = 'public'::regnamespace
  union all
  select 'indexes', indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
  union all
  select 'functions', p.proname || ':' || md5(replace(p.prosrc, chr(13), '')) || ':' || p.provolatile::text || ':' || p.prosecdef::text
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'triggers', tgrelid::regclass::text || ':' || tgname from pg_trigger where not tgisinternal
    and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
  union all
  select 'policies', tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public'
  union all
  select 'rls', relname || ':' || relrowsecurity::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  union all
  select 'enums', t.typname || ':' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typnamespace = 'public'::regnamespace group by t.typname
  union all
  select 'grants', table_name || ':' || grantee || ':' || privilege_type
    from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')
  union all
  select 'column_grants', table_name || '.' || column_name || ':' || grantee || ':' || privilege_type
    from information_schema.column_privileges where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'UPDATE'
  union all
  select 'seed', name || ':' || installment_cop::text || ':' || total_cop::text from chain_products
  union all
  select 'seed', day::text || ':' || name from co_holidays
) x
group by section order by section;
