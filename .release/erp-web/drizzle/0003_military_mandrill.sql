PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_inventory_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`lot_no` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit` text NOT NULL,
	`expires_at` text NOT NULL,
	`location` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inventory_quantity_nonnegative" CHECK("__new_inventory_lots"."quantity" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_inventory_lots`("id", "tenant_id", "site_id", "ingredient_name", "lot_no", "quantity", "unit", "expires_at", "location", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "ingredient_name", "lot_no", "quantity", "unit", "expires_at", "location", "status", "created_at", "updated_at" FROM `inventory_lots`;--> statement-breakpoint
DROP TABLE `inventory_lots`;--> statement-breakpoint
ALTER TABLE `__new_inventory_lots` RENAME TO `inventory_lots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inventory_lots_tenant_lot` ON `inventory_lots` (`tenant_id`,`lot_no`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lots_tenant_expiry` ON `inventory_lots` (`tenant_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lots_tenant_status` ON `inventory_lots` (`tenant_id`,`status`);