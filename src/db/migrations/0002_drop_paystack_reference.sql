ALTER TABLE "orders" DROP CONSTRAINT "orders_paystack_reference_unique";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "paystack_reference";