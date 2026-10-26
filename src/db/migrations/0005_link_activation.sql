ALTER TABLE "order_items" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "message_ids" integer[] DEFAULT '{}'::integer[] NOT NULL;