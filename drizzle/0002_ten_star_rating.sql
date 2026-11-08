-- The rating scale goes from 0.5–5 to 0.5–10, in half steps. Every existing
-- rating doubles, so a 4 becomes an 8 and keeps its meaning. The order holds
-- the old and new constraints at each step: widen the type first (numeric(2,1)
-- tops out at 9.9), drop the old check, double, then add the new check.
ALTER TABLE "title_status" ALTER COLUMN "rating" SET DATA TYPE numeric(3, 1);--> statement-breakpoint
ALTER TABLE "title_status" DROP CONSTRAINT "title_status_rating_scale_check";--> statement-breakpoint
UPDATE "title_status" SET "rating" = "rating" * 2 WHERE "rating" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "title_status" ADD CONSTRAINT "title_status_rating_scale_check" CHECK ("title_status"."rating" is null or ("title_status"."rating" between 0.5 and 10 and "title_status"."rating" * 2 = trunc("title_status"."rating" * 2)));
