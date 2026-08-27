PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_idempotency_keys` (
	`key` text NOT NULL,
	`tenant_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`lease_token` text DEFAULT '' NOT NULL,
	`lease_expires_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `key`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_idempotency_keys`
	(`key`, `tenant_id`, `request_hash`, `response_json`, `lease_token`, `lease_expires_at`, `created_at`)
SELECT `key`, `tenant_id`, `request_hash`, `response_json`, '', NULL, `created_at`
FROM `idempotency_keys`;--> statement-breakpoint
DROP TABLE `idempotency_keys`;--> statement-breakpoint
ALTER TABLE `__new_idempotency_keys` RENAME TO `idempotency_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
