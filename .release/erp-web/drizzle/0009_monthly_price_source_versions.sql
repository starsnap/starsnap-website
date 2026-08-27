ALTER TABLE `product_price_bulk_staging` ADD `expected_source_month` text;--> statement-breakpoint
ALTER TABLE `product_price_bulk_staging` ADD `expected_source_version` integer NOT NULL DEFAULT 1;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_products_monthly_price_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_products_monthly_price_insert_v2`;--> statement-breakpoint
CREATE TRIGGER `trg_products_monthly_price_insert_v2`
AFTER INSERT ON `products`
BEGIN
  INSERT INTO `product_monthly_prices`
    (`tenant_id`, `product_id`, `price_month`,
     `school_price_kg`, `school_price_spec`, `school_price_each`,
     `vendor_price_kg`, `vendor_price_spec`, `vendor_price_each`,
     `purchase_price_kg`, `purchase_price_spec`, `purchase_price_each`,
     `price_version`, `created_at`, `updated_at`)
  VALUES
    (NEW.`tenant_id`, NEW.`id`, strftime('%Y-%m', NEW.`created_at`, '+9 hours'),
     NEW.`school_price_kg`, NEW.`school_price_spec`, NEW.`school_price_each`,
     NEW.`vendor_price_kg`, NEW.`vendor_price_spec`, NEW.`vendor_price_each`,
     NEW.`purchase_price_kg`, NEW.`purchase_price_spec`, NEW.`purchase_price_each`,
     1, NEW.`created_at`, NEW.`updated_at`)
  ON CONFLICT (`tenant_id`, `product_id`, `price_month`) DO NOTHING;
END;
