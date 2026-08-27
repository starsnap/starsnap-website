CREATE TABLE `product_bulk_staging` (
	`tenant_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`lease_token` text NOT NULL,
	`row_number` integer NOT NULL,
	`action` text NOT NULL,
	`product_id` text NOT NULL,
	`expected_version` integer,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`specification` text NOT NULL,
	`unit` text NOT NULL,
	`school_price_kg` integer NOT NULL,
	`school_price_spec` integer NOT NULL,
	`school_price_each` integer NOT NULL,
	`vendor_price_kg` integer NOT NULL,
	`vendor_price_spec` integer NOT NULL,
	`vendor_price_each` integer NOT NULL,
	`purchase_price_kg` integer NOT NULL,
	`purchase_price_spec` integer NOT NULL,
	`purchase_price_each` integer NOT NULL,
	`supplier_name` text NOT NULL,
	`storage_type` text NOT NULL,
	`allergens` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `idempotency_key`, `lease_token`, `row_number`),
	CONSTRAINT `chk_product_bulk_staging_action` CHECK(`action` IN ('create', 'update')),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_product_bulk_staging_scope_action` ON `product_bulk_staging` (`tenant_id`,`idempotency_key`,`lease_token`,`action`);--> statement-breakpoint
CREATE INDEX `idx_product_bulk_staging_created_at` ON `product_bulk_staging` (`created_at`);
