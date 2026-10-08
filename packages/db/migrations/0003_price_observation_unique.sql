-- Earlier price-guard cycles wrote a row per cycle even when the reading had not changed.
-- Keep one row per (asset, source, observed_at) so the unique index can be created.
DELETE FROM "price_observation" a USING "price_observation" b
WHERE a."asset_id" = b."asset_id" AND a."source" = b."source" AND a."observed_at" = b."observed_at"
  AND a."id" > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_observation_asset_source_observed_uq" ON "price_observation" USING btree ("asset_id","source","observed_at");