CREATE TABLE IF NOT EXISTS "compliance_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"kind" text DEFAULT 'sanctions' NOT NULL,
	"result" text NOT NULL,
	"matches" jsonb,
	"list_source" text,
	"list_loaded_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compliance_check" ADD CONSTRAINT "compliance_check_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compliance_check_party_idx" ON "compliance_check" USING btree ("party_id","checked_at");