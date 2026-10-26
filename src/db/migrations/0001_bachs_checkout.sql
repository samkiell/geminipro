DROP INDEX "events_paystack_webhook_ref_idx";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_reference" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "events_bachs_webhook_ref_idx" ON "events" USING btree ("kind","ref") WHERE kind = 'bachs_webhook';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_reference_unique" UNIQUE("payment_reference");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_id_unique" UNIQUE("checkout_id");