CREATE TABLE `ingestion_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_key` text NOT NULL,
	`source_id` text NOT NULL,
	`source_name` text NOT NULL,
	`channel_name` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`published_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_dedupe_key_unique` ON `items` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `items_published_at_idx` ON `items` (`published_at`);--> statement-breakpoint
CREATE INDEX `items_source_id_idx` ON `items` (`source_id`);--> statement-breakpoint
CREATE INDEX `items_first_seen_at_idx` ON `items` (`first_seen_at`);--> statement-breakpoint
CREATE TABLE `source_status` (
	`source_id` text PRIMARY KEY NOT NULL,
	`last_attempt_at` integer,
	`last_success_at` integer,
	`status` text DEFAULT 'idle' NOT NULL,
	`error` text,
	`item_count` integer DEFAULT 0 NOT NULL
);
