ALTER TABLE "chain_event" ADD COLUMN "event_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chain_event_event_id_uq" ON "chain_event" USING btree ("event_id");