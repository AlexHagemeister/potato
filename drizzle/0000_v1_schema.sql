CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imdb_ratings" (
	"tconst" text PRIMARY KEY NOT NULL,
	"average_rating" numeric(3, 1) NOT NULL,
	"num_votes" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "title_status" (
	"user_id" text NOT NULL,
	"media_type" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"status" text NOT NULL,
	"rating" numeric(2, 1),
	"review" text,
	"review_visibility" text DEFAULT 'private' NOT NULL,
	"skip_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "title_status_pkey" PRIMARY KEY("user_id","media_type","tmdb_id"),
	CONSTRAINT "title_status_media_type_check" CHECK ("title_status"."media_type" in ('movie', 'tv')),
	CONSTRAINT "title_status_tmdb_id_check" CHECK ("title_status"."tmdb_id" > 0),
	CONSTRAINT "title_status_status_check" CHECK ("title_status"."status" in ('watchlist', 'passed', 'seen', 'skipped')),
	CONSTRAINT "title_status_rating_scale_check" CHECK ("title_status"."rating" is null or ("title_status"."rating" between 0.5 and 5 and "title_status"."rating" * 2 = trunc("title_status"."rating" * 2))),
	CONSTRAINT "title_status_rating_iff_seen_check" CHECK (("title_status"."status" = 'seen') = ("title_status"."rating" is not null)),
	CONSTRAINT "title_status_review_only_seen_check" CHECK ("title_status"."review" is null or "title_status"."status" = 'seen'),
	CONSTRAINT "title_status_review_visibility_check" CHECK ("title_status"."review_visibility" in ('private')),
	CONSTRAINT "title_status_skip_until_iff_skipped_check" CHECK (("title_status"."status" = 'skipped') = ("title_status"."skip_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "tmdb_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"provider_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_country_check" CHECK ("user_settings"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_status" ADD CONSTRAINT "title_status_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "title_status_user_id_status_idx" ON "title_status" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tmdb_cache_expires_at_idx" ON "tmdb_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");