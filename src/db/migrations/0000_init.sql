CREATE TYPE "public"."order_status" AS ENUM('created', 'awaiting_payment', 'paid', 'fulfilling', 'partial', 'delivered', 'expired', 'needs_attention', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reseller_order_code" text,
	"activation_link" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "order_items_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "order_items_order_id_idx_unique" UNIQUE("order_id","idx")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_ngn" integer NOT NULL,
	"fee_ngn" integer DEFAULT 0 NOT NULL,
	"amount_ngn" integer NOT NULL,
	"status" "order_status" DEFAULT 'created' NOT NULL,
	"paystack_reference" text NOT NULL,
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"nudge_sent" boolean DEFAULT false NOT NULL,
	"fulfil_lease_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_paystack_reference_unique" UNIQUE("paystack_reference"),
	CONSTRAINT "orders_quantity_check" CHECK ("orders"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"telegram_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"first_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_telegram_id_users_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."users"("telegram_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_paystack_webhook_ref_idx" ON "events" USING btree ("kind","ref") WHERE kind = 'paystack_webhook';--> statement-breakpoint
CREATE INDEX "orders_status_updated_at_idx" ON "orders" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "orders_telegram_id_created_at_idx" ON "orders" USING btree ("telegram_id","created_at" DESC NULLS LAST);