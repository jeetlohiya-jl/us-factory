-- Production, part 3: records which logged-in user actually filled in and
-- saved a Production record's editable fields (Rejection Classification,
-- Wastage, FG Pallets Generated) -- separate from created_by, which
-- captures whoever triggered the record's auto-creation from Material
-- Consumption (usually the same person, but not necessarily -- a run can
-- sit Pending for a while before someone completes it).

alter table production_runs add column if not exists completed_by uuid references app_users(id);
alter table production_runs add column if not exists completed_at timestamptz;
