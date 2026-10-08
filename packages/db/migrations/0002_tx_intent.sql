CREATE TABLE IF NOT EXISTS "tx_intent" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid,
	"party_id" uuid NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"ledger" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "repo_trade" ADD COLUMN "contract_trade_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tx_intent" ADD CONSTRAINT "tx_intent_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
