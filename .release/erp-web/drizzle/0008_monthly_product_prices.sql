CREATE UNIQUE INDEX IF NOT EXISTS `uq_products_tenant_id`
ON `products` (`tenant_id`, `id`);--> statement-breakpoint
CREATE TABLE `product_monthly_prices` (
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`price_month` text NOT NULL,
	`school_price_kg` integer NOT NULL,
	`school_price_spec` integer NOT NULL,
	`school_price_each` integer NOT NULL,
	`vendor_price_kg` integer NOT NULL,
	`vendor_price_spec` integer NOT NULL,
	`vendor_price_each` integer NOT NULL,
	`purchase_price_kg` integer NOT NULL,
	`purchase_price_spec` integer NOT NULL,
	`purchase_price_each` integer NOT NULL,
	`price_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `product_id`, `price_month`),
	CONSTRAINT `chk_product_monthly_prices_month` CHECK(
		length(`price_month`) = 7
		AND `price_month` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
		AND substr(`price_month`, 6, 2) BETWEEN '01' AND '12'
	),
	CONSTRAINT `chk_product_monthly_prices_school_kg` CHECK(`school_price_kg` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_school_spec` CHECK(`school_price_spec` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_school_each` CHECK(`school_price_each` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_vendor_kg` CHECK(`vendor_price_kg` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_vendor_spec` CHECK(`vendor_price_spec` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_vendor_each` CHECK(`vendor_price_each` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_purchase_kg` CHECK(`purchase_price_kg` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_purchase_spec` CHECK(`purchase_price_spec` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_purchase_each` CHECK(`purchase_price_each` BETWEEN 0 AND 100000000),
	CONSTRAINT `chk_product_monthly_prices_version` CHECK(`price_version` >= 1),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`, `product_id`)
		REFERENCES `products` (`tenant_id`, `id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `idx_product_monthly_prices_tenant_month`
ON `product_monthly_prices` (`tenant_id`, `price_month`, `product_id`);--> statement-breakpoint
CREATE TABLE `product_price_bulk_staging` (
	`tenant_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`lease_token` text NOT NULL,
	`row_number` integer NOT NULL,
	`product_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`school_price_kg` integer NOT NULL,
	`school_price_spec` integer NOT NULL,
	`school_price_each` integer NOT NULL,
	`vendor_price_kg` integer NOT NULL,
	`vendor_price_spec` integer NOT NULL,
	`vendor_price_each` integer NOT NULL,
	`purchase_price_kg` integer NOT NULL,
	`purchase_price_spec` integer NOT NULL,
	`purchase_price_each` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `idempotency_key`, `lease_token`, `row_number`),
	CONSTRAINT `chk_product_price_bulk_staging_version` CHECK(`expected_version` >= 0),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `idx_product_price_bulk_staging_scope`
ON `product_price_bulk_staging` (`tenant_id`, `idempotency_key`, `lease_token`);--> statement-breakpoint
CREATE INDEX `idx_product_price_bulk_staging_created_at`
ON `product_price_bulk_staging` (`created_at`);--> statement-breakpoint
INSERT INTO `product_monthly_prices` (
	`tenant_id`, `product_id`, `price_month`,
	`school_price_kg`, `school_price_spec`, `school_price_each`,
	`vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
	`purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`,
	`price_version`, `created_at`, `updated_at`
)
SELECT
	`tenant_id`, `id`, strftime('%Y-%m', 'now', '+9 hours'),
	`school_price_kg`, `school_price_spec`, `school_price_each`,
	`vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
	`purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`,
	1,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `products`
WHERE 1
ON CONFLICT (`tenant_id`, `product_id`, `price_month`) DO NOTHING;--> statement-breakpoint
CREATE TRIGGER `trg_products_monthly_price_insert`
AFTER INSERT ON `products`
BEGIN
	INSERT INTO `product_monthly_prices` (
		`tenant_id`, `product_id`, `price_month`,
		`school_price_kg`, `school_price_spec`, `school_price_each`,
		`vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
		`purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`,
		`price_version`, `created_at`, `updated_at`
	) VALUES (
		NEW.`tenant_id`, NEW.`id`, strftime('%Y-%m', 'now', '+9 hours'),
		NEW.`school_price_kg`, NEW.`school_price_spec`, NEW.`school_price_each`,
		NEW.`vendor_price_kg`, NEW.`vendor_price_spec`, NEW.`vendor_price_each`,
		NEW.`purchase_price_kg`, NEW.`purchase_price_spec`, NEW.`purchase_price_each`,
		1, NEW.`created_at`, NEW.`updated_at`
	)
	ON CONFLICT (`tenant_id`, `product_id`, `price_month`) DO NOTHING;
END;
