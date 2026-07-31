CREATE TABLE `backfill_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requested_source_id` text,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backfill_runs_status_idx` ON `backfill_runs` (`status`);
--> statement-breakpoint
CREATE TABLE `backfill_source_runs` (
	`run_id` integer NOT NULL,
	`source_id` text NOT NULL,
	`status` text NOT NULL,
	`cursor` text,
	`pages_fetched` integer DEFAULT 0 NOT NULL,
	`items_fetched` integer DEFAULT 0 NOT NULL,
	`items_in_window` integer DEFAULT 0 NOT NULL,
	`items_inserted` integer DEFAULT 0 NOT NULL,
	`items_existing` integer DEFAULT 0 NOT NULL,
	`earliest_covered_at` integer,
	`error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`run_id`, `source_id`),
	FOREIGN KEY (`run_id`) REFERENCES `backfill_runs` (`id`)
);
