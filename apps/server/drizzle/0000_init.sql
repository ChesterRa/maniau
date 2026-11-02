CREATE TABLE "events" (
	"household_id" text NOT NULL,
	"seq" integer NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"occurred_at" text NOT NULL,
	"recorded_at" text NOT NULL,
	"actor_id" text NOT NULL,
	"op_id" text,
	"body" jsonb NOT NULL,
	CONSTRAINT "events_household_id_seq_pk" PRIMARY KEY("household_id","seq")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"region" text NOT NULL,
	"time_zone" text NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "members" (
	"household_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"identity_id" text,
	CONSTRAINT "members_household_id_id_pk" PRIMARY KEY("household_id","id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"household_id" text NOT NULL,
	"op_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"digest" text NOT NULL,
	"through_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_household_id_op_id_pk" PRIMARY KEY("household_id","op_id")
);
--> statement-breakpoint
CREATE TABLE "payloads" (
	"household_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"sha256" text,
	"body" jsonb,
	"deleted_at" timestamp with time zone,
	"deleted_reason" text,
	CONSTRAINT "payloads_household_id_id_pk" PRIMARY KEY("household_id","id")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payloads" ADD CONSTRAINT "payloads_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_household_id" ON "events" USING btree ("household_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_issuer_subject" ON "identities" USING btree ("issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "members_household_identity" ON "members" USING btree ("household_id","identity_id");