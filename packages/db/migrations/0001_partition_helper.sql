-- 0001_partition_helper.sql
-- A function to lazily create month-partitions for asset_locations.
-- The worker calls this on startup and once per day. In prod, run via cron.
-- Idempotent: re-creating an existing partition is a no-op.

CREATE OR REPLACE FUNCTION ensure_asset_locations_partition(target DATE)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  start_date DATE := date_trunc('month', target)::date;
  end_date   DATE := (start_date + INTERVAL '1 month')::date;
  part_name  TEXT := format('asset_locations_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF asset_locations
       FOR VALUES FROM (%L) TO (%L)',
    part_name, start_date, end_date
  );
END;
$$;

-- Create the partition for the current month and the next two months so
-- ingestion never fails right after a fresh install.
SELECT ensure_asset_locations_partition(now()::date);
SELECT ensure_asset_locations_partition((now() + INTERVAL '1 month')::date);
SELECT ensure_asset_locations_partition((now() + INTERVAL '2 months')::date);
