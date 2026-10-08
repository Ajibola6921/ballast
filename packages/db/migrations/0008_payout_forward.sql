CREATE TABLE IF NOT EXISTS "payout_forward" (
	"from_tx_hash" text PRIMARY KEY NOT NULL,
	"to_account" text NOT NULL,
	"amount" numeric(32, 7) NOT NULL,
	"memo" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
