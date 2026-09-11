ALTER TABLE "appointments" ADD COLUMN "collision_event_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "google_access_lost_at" timestamp with time zone;