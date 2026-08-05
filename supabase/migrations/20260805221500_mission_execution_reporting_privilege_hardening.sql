begin;

revoke all privileges on table public.mission_execution_reports from service_role;
grant select, insert on table public.mission_execution_reports to service_role;

commit;

-- Rollback plan:
-- revoke all privileges on table public.mission_execution_reports from service_role;
-- grant select, insert, update, delete, truncate, references, trigger
--   on table public.mission_execution_reports to service_role;
