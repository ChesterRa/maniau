CREATE TABLE "notification_intents" (
	"household_id" text NOT NULL,
	"key" text NOT NULL,
	"member_id" text NOT NULL,
	"kind" text NOT NULL,
	"until" timestamp with time zone,
	"round" integer DEFAULT 1 NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" text,
	"not_before" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_intents_household_id_key_pk" PRIMARY KEY("household_id","key")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"member_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"language" text NOT NULL,
	"registration" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "batch" integer;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "notified_through_seq" integer;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_household_id_member_id_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_member" ON "push_subscriptions" USING btree ("household_id","member_id");