CREATE SEQUENCE "public"."order_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1;--> statement-breakpoint
CREATE TABLE "leads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_no" text DEFAULT 'GP-' || nextval('order_no_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "summary_message_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pay_message_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "status_message_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "activated_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lang" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_no_unique" UNIQUE("order_no");