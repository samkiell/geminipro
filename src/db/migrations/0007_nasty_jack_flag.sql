CREATE TABLE "order_drafts" (
	"telegram_id" bigint PRIMARY KEY NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"message_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
