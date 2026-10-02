ALTER TABLE "request_usage" ADD COLUMN "requested_service_tier" text;--> statement-breakpoint
ALTER TABLE "request_usage" ADD COLUMN "requested_service_tier_raw" text;--> statement-breakpoint
ALTER TABLE "request_usage" ADD COLUMN "service_tier" text;--> statement-breakpoint
ALTER TABLE "request_usage" ADD COLUMN "service_tier_raw" text;