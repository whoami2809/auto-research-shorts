-- Additive migration: preserves existing application data and authentication.
create table public.shorts_workflow_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 0 check (version >= 0),
  document jsonb not null check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 4194304),
  dispatch_hash text,
  dispatch_token text,
  dispatch_request uuid,
  dispatch_expires_at timestamptz,
  constraint shorts_dispatch_hash_length check (dispatch_hash is null or dispatch_hash ~ '^[a-f0-9]{64}$')
);
create index shorts_workflow_jobs_owner_created on public.shorts_workflow_jobs (owner_id,created_at desc);
alter table public.shorts_workflow_jobs enable row level security;
revoke all on public.shorts_workflow_jobs from anon,authenticated;
-- Only the authenticated backend can enqueue or mutate tool/paid execution state.
-- The client may inspect its own non-capability columns, never change approval flags.
grant select (id,owner_id,created_at,updated_at,version,document) on public.shorts_workflow_jobs to authenticated;
grant all on public.shorts_workflow_jobs to service_role;
create policy shorts_jobs_read_own on public.shorts_workflow_jobs for select to authenticated
  using ((select auth.uid())=owner_id);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('shorts-workflow','shorts-workflow',false,262144000,
array['image/png','image/jpeg','video/mp4','audio/mpeg','audio/wav','text/plain','application/zip']);
-- Private artifacts: clients can read only their owner prefix. All writes are server-controlled.
create policy shorts_artifacts_read_own on storage.objects for select to authenticated
  using (bucket_id='shorts-workflow' and (storage.foldername(name))[1]=(select auth.uid())::text);
