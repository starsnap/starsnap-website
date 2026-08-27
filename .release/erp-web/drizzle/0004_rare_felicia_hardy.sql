CREATE TABLE IF NOT EXISTS `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`specification` text NOT NULL,
	`unit` text NOT NULL,
	`unit_price` integer NOT NULL,
	`supplier_name` text NOT NULL,
	`storage_type` text NOT NULL,
	`allergens` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_products_unit_price_nonnegative" CHECK("products"."unit_price" >= 0),
	CONSTRAINT "chk_products_version_positive" CHECK("products"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_products_tenant_sku` ON `products` (`tenant_id`,`sku`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_products_tenant_name` ON `products` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_products_tenant_status` ON `products` (`tenant_id`,`status`);
