CREATE TABLE IF NOT EXISTS "api_key_nonce" (
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_nonce_key_id_nonce_pk" PRIMARY KEY("key_id","nonce")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"stellar_account" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "party_api_key" ADD CONSTRAINT "party_api_key_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "party_api_key_key_id_uq" ON "party_api_key" USING btree ("key_id");