PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_price_v2_backup` (
	`product_id` text PRIMARY KEY NOT NULL,
	`school_price_kg` integer NOT NULL,
	`school_price_spec` integer NOT NULL,
	`school_price_each` integer NOT NULL,
	`vendor_price_kg` integer NOT NULL,
	`vendor_price_spec` integer NOT NULL,
	`vendor_price_each` integer NOT NULL,
	`purchase_price_kg` integer NOT NULL,
	`purchase_price_spec` integer NOT NULL,
	`purchase_price_each` integer NOT NULL
);--> statement-breakpoint
CREATE TEMP TABLE `__product_price_v2_migration_guard` (
	`safe_to_migrate` integer NOT NULL CHECK (`safe_to_migrate` = 1)
);--> statement-breakpoint
INSERT INTO `__product_price_v2_migration_guard` (`safe_to_migrate`)
SELECT CASE
	WHEN EXISTS (
		SELECT 1 FROM pragma_table_info('products') WHERE name = 'school_price_kg'
	) AND EXISTS (
		SELECT 1
		FROM `products` AS `product`
		LEFT JOIN `product_price_v2_backup` AS `backup`
			ON `backup`.`product_id` = `product`.`id`
		WHERE `backup`.`product_id` IS NULL
	)
	THEN 0 ELSE 1
END;--> statement-breakpoint
DROP TABLE `__product_price_v2_migration_guard`;--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`specification` text NOT NULL,
	`unit` text NOT NULL,
	`unit_price` integer NOT NULL,
	`school_price_kg` integer DEFAULT 0 NOT NULL,
	`school_price_spec` integer DEFAULT 0 NOT NULL,
	`school_price_each` integer DEFAULT 0 NOT NULL,
	`vendor_price_kg` integer DEFAULT 0 NOT NULL,
	`vendor_price_spec` integer DEFAULT 0 NOT NULL,
	`vendor_price_each` integer DEFAULT 0 NOT NULL,
	`purchase_price_kg` integer DEFAULT 0 NOT NULL,
	`purchase_price_spec` integer DEFAULT 0 NOT NULL,
	`purchase_price_each` integer DEFAULT 0 NOT NULL,
	`supplier_name` text NOT NULL,
	`storage_type` text NOT NULL,
	`allergens` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_products_unit_price_nonnegative" CHECK("__new_products"."unit_price" >= 0),
	CONSTRAINT "chk_products_unit_price_max" CHECK("__new_products"."unit_price" <= 100000000),
	CONSTRAINT "chk_products_school_price_kg_range" CHECK("__new_products"."school_price_kg" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_school_price_spec_range" CHECK("__new_products"."school_price_spec" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_school_price_each_range" CHECK("__new_products"."school_price_each" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_vendor_price_kg_range" CHECK("__new_products"."vendor_price_kg" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_vendor_price_spec_range" CHECK("__new_products"."vendor_price_spec" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_vendor_price_each_range" CHECK("__new_products"."vendor_price_each" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_purchase_price_kg_range" CHECK("__new_products"."purchase_price_kg" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_purchase_price_spec_range" CHECK("__new_products"."purchase_price_spec" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_purchase_price_each_range" CHECK("__new_products"."purchase_price_each" BETWEEN 0 AND 100000000),
	CONSTRAINT "chk_products_version_positive" CHECK("__new_products"."version" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_products` (
	"id", "tenant_id", "sku", "name", "category", "specification", "unit", "unit_price",
	"school_price_kg", "school_price_spec", "school_price_each",
	"vendor_price_kg", "vendor_price_spec", "vendor_price_each",
	"purchase_price_kg", "purchase_price_spec", "purchase_price_each",
	"supplier_name", "storage_type", "allergens", "status", "version", "created_at", "updated_at"
)
SELECT
	`product`.`id`, `product`.`tenant_id`, `product`.`sku`, `product`.`name`,
	`product`.`category`, `product`.`specification`, `product`.`unit`,
	CASE
		WHEN `backup`.`product_id` IS NULL THEN `product`.`unit_price`
		WHEN `product`.`unit` = 'KG' THEN `backup`.`purchase_price_kg`
		WHEN `product`.`unit` = 'EA' THEN `backup`.`purchase_price_each`
		ELSE `backup`.`purchase_price_spec`
	END,
	COALESCE(`backup`.`school_price_kg`, 0),
	COALESCE(`backup`.`school_price_spec`, 0),
	COALESCE(`backup`.`school_price_each`, 0),
	COALESCE(`backup`.`vendor_price_kg`, 0),
	COALESCE(`backup`.`vendor_price_spec`, 0),
	COALESCE(`backup`.`vendor_price_each`, 0),
	COALESCE(`backup`.`purchase_price_kg`, CASE WHEN `product`.`unit` = 'KG' THEN `product`.`unit_price` ELSE 0 END),
	COALESCE(`backup`.`purchase_price_spec`, CASE WHEN `product`.`unit` NOT IN ('KG', 'EA') THEN `product`.`unit_price` ELSE 0 END),
	COALESCE(`backup`.`purchase_price_each`, CASE WHEN `product`.`unit` = 'EA' THEN `product`.`unit_price` ELSE 0 END),
	`product`.`supplier_name`, `product`.`storage_type`, `product`.`allergens`,
	`product`.`status`, `product`.`version`, `product`.`created_at`, `product`.`updated_at`
FROM `products` AS `product`
LEFT JOIN `product_price_v2_backup` AS `backup`
	ON `backup`.`product_id` = `product`.`id`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_tenant_sku` ON `products` (`tenant_id`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_products_tenant_name` ON `products` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_products_tenant_status` ON `products` (`tenant_id`,`status`);--> statement-breakpoint
INSERT OR REPLACE INTO `product_price_v2_backup` (
	`product_id`, `school_price_kg`, `school_price_spec`, `school_price_each`,
	`vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
	`purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`
)
SELECT
	`id`, `school_price_kg`, `school_price_spec`, `school_price_each`,
	`vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
	`purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`
FROM `products`;--> statement-breakpoint
CREATE TRIGGER `trg_products_price_backup_insert`
AFTER INSERT ON `products`
BEGIN
	INSERT OR REPLACE INTO `product_price_v2_backup` (
		`product_id`, `school_price_kg`, `school_price_spec`, `school_price_each`,
		`vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
		`purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`
	) VALUES (
		NEW.`id`, NEW.`school_price_kg`, NEW.`school_price_spec`, NEW.`school_price_each`,
		NEW.`vendor_price_kg`, NEW.`vendor_price_spec`, NEW.`vendor_price_each`,
		NEW.`purchase_price_kg`, NEW.`purchase_price_spec`, NEW.`purchase_price_each`
	);
END;--> statement-breakpoint
CREATE TRIGGER `trg_products_price_backup_update`
AFTER UPDATE ON `products`
BEGIN
	INSERT OR REPLACE INTO `product_price_v2_backup` (
		`product_id`, `school_price_kg`, `school_price_spec`, `school_price_each`,
		`vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
		`purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`
	) VALUES (
		NEW.`id`, NEW.`school_price_kg`, NEW.`school_price_spec`, NEW.`school_price_each`,
		NEW.`vendor_price_kg`, NEW.`vendor_price_spec`, NEW.`vendor_price_each`,
		NEW.`purchase_price_kg`, NEW.`purchase_price_spec`, NEW.`purchase_price_each`
	);
END;--> statement-breakpoint
CREATE TRIGGER `trg_products_price_backup_delete`
AFTER DELETE ON `products`
BEGIN
	DELETE FROM `product_price_v2_backup` WHERE `product_id` = OLD.`id`;
END;
