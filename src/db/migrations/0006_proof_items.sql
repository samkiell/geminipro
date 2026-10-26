CREATE TABLE "proof_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"file_id" text,
	"caption" text,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_items_key_unique" UNIQUE("key")
);
