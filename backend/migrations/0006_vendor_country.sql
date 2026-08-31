-- Country-of-origin for Vendors, and the RM pallet-numbering change that
-- depends on it.
--
-- Until now every pallet display_id used a hardcoded "US-" prefix
-- (US-PLT-2608-0091, US-PAD-..., etc.) regardless of where the raw material
-- actually shipped from. The correct rule: the first two letters identify
-- the country the pallet was PACKED in. RM pallets are packed at the
-- vendor's site, so their prefix must reflect the vendor's country (e.g. a
-- vendor in China gives "CN-PLT-...", not "US-PLT-..."). FG pallets are
-- always packed at this US factory, so their prefix stays "US-" regardless
-- of any RM vendor involved upstream -- that part of the numbering scheme
-- doesn't change.
--
-- This requires Vendor to actually record a country (it never did before --
-- vendor_name was always just a free-text snapshot with no other vendor
-- attributes surfaced downstream), and the QR Generation batch to snapshot
-- which country applied at the moment the batch was created (same
-- snapshot-at-creation pattern as sku_code_snapshot) so a later edit to the
-- vendor's country never rewrites the numbering of pallets already
-- generated.

alter table vendors add column if not exists country text;
-- Existing vendors predate this field entirely. Defaulting them to 'US'
-- preserves the exact prefixes ("US-PLT-...") already printed on every
-- pallet generated so far -- a silent default of anything else would be a
-- real, retroactive change to already-generated data.
update vendors set country = 'US' where country is null;

alter table qr_generation_records add column if not exists country_code text;
-- Same backfill reasoning: every batch generated before this migration was,
-- in effect, always treated as 'US' by the old hardcoded prefix logic.
update qr_generation_records set country_code = 'US' where country_code is null;
