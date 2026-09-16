-- Adds a genuinely new "SKU Code" field to sku_codes, distinct from both:
--   * `code`          -- functions as "SKU Name" in the UI (unique, required)
--   * `batch_number`  -- numeric-only, used as the first segment of the FG
--                        Storage Batch Code (added in 0033)
-- Per explicit user clarification: "my sku code has numbers and alphabets :
-- batch number is onky the numbers without the alphabet" -- i.e. SKU Code is
-- alphanumeric and is a separate concept from Batch Number. Nullable/optional,
-- matching the existing optional-at-creation pattern for batch_number.
alter table sku_codes add column if not exists sku_code text;
