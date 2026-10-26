CREATE TABLE "referrals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"referrer_id" bigint NOT NULL,
	"referred_id" bigint NOT NULL,
	"qualified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_referred_id_unique" UNIQUE("referred_id")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source" text DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ref_code" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referred_by" bigint;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_telegram_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("telegram_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_id_users_telegram_id_fk" FOREIGN KEY ("referred_id") REFERENCES "public"."users"("telegram_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referrals_referrer_id_idx" ON "referrals" USING btree ("referrer_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_ref_code_unique" UNIQUE("ref_code");