PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`delivery_no` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`driver_name` text NOT NULL,
	`vehicle_no` text NOT NULL,
	`servings` integer NOT NULL,
	`temperature` integer,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_deliveries`("id", "tenant_id", "site_id", "delivery_no", "scheduled_at", "driver_name", "vehicle_no", "servings", "temperature", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "delivery_no", "scheduled_at", "driver_name", "vehicle_no", "servings", "temperature", "status", "created_at", "updated_at" FROM `deliveries`;--> statement-breakpoint
DROP TABLE `deliveries`;--> statement-breakpoint
ALTER TABLE `__new_deliveries` RENAME TO `deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_deliveries_tenant_no` ON `deliveries` (`tenant_id`,`delivery_no`);--> statement-breakpoint
CREATE INDEX `idx_deliveries_tenant_status` ON `deliveries` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_haccp_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`check_date` text NOT NULL,
	`category` text NOT NULL,
	`item_name` text NOT NULL,
	`measured_value` text NOT NULL,
	`assignee_name` text NOT NULL,
	`corrective_action` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_haccp_checks`("id", "tenant_id", "site_id", "check_date", "category", "item_name", "measured_value", "assignee_name", "corrective_action", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "check_date", "category", "item_name", "measured_value", "assignee_name", "corrective_action", "status", "created_at", "updated_at" FROM `haccp_checks`;--> statement-breakpoint
DROP TABLE `haccp_checks`;--> statement-breakpoint
ALTER TABLE `__new_haccp_checks` RENAME TO `haccp_checks`;--> statement-breakpoint
CREATE INDEX `idx_haccp_checks_tenant_date` ON `haccp_checks` (`tenant_id`,`check_date`);--> statement-breakpoint
CREATE INDEX `idx_haccp_checks_tenant_status` ON `haccp_checks` (`tenant_id`,`status`);--> statement-breakpoint
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
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_inventory_lots`("id", "tenant_id", "site_id", "ingredient_name", "lot_no", "quantity", "unit", "expires_at", "location", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "ingredient_name", "lot_no", "quantity", "unit", "expires_at", "location", "status", "created_at", "updated_at" FROM `inventory_lots`;--> statement-breakpoint
DROP TABLE `inventory_lots`;--> statement-breakpoint
ALTER TABLE `__new_inventory_lots` RENAME TO `inventory_lots`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inventory_lots_tenant_lot` ON `inventory_lots` (`tenant_id`,`lot_no`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lots_tenant_expiry` ON `inventory_lots` (`tenant_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lots_tenant_status` ON `inventory_lots` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_meal_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`service_date` text NOT NULL,
	`meal_type` text NOT NULL,
	`menu_name` text NOT NULL,
	`planned_servings` integer NOT NULL,
	`actual_servings` integer,
	`allergens` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_meal_plans`("id", "tenant_id", "site_id", "service_date", "meal_type", "menu_name", "planned_servings", "actual_servings", "allergens", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "service_date", "meal_type", "menu_name", "planned_servings", "actual_servings", "allergens", "status", "created_at", "updated_at" FROM `meal_plans`;--> statement-breakpoint
DROP TABLE `meal_plans`;--> statement-breakpoint
ALTER TABLE `__new_meal_plans` RENAME TO `meal_plans`;--> statement-breakpoint
CREATE INDEX `idx_meal_plans_tenant_date` ON `meal_plans` (`tenant_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `idx_meal_plans_tenant_status` ON `meal_plans` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_production_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`service_date` text NOT NULL,
	`menu_name` text NOT NULL,
	`planned_quantity` integer NOT NULL,
	`actual_quantity` integer,
	`core_temperature` integer,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_production_orders`("id", "tenant_id", "site_id", "service_date", "menu_name", "planned_quantity", "actual_quantity", "core_temperature", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "service_date", "menu_name", "planned_quantity", "actual_quantity", "core_temperature", "status", "created_at", "updated_at" FROM `production_orders`;--> statement-breakpoint
DROP TABLE `production_orders`;--> statement-breakpoint
ALTER TABLE `__new_production_orders` RENAME TO `production_orders`;--> statement-breakpoint
CREATE INDEX `idx_production_orders_tenant_date` ON `production_orders` (`tenant_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `idx_production_orders_tenant_status` ON `production_orders` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`order_no` text NOT NULL,
	`supplier_name` text NOT NULL,
	`delivery_date` text NOT NULL,
	`total_amount` integer NOT NULL,
	`item_count` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_purchase_orders`("id", "tenant_id", "site_id", "order_no", "supplier_name", "delivery_date", "total_amount", "item_count", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "order_no", "supplier_name", "delivery_date", "total_amount", "item_count", "status", "created_at", "updated_at" FROM `purchase_orders`;--> statement-breakpoint
DROP TABLE `purchase_orders`;--> statement-breakpoint
ALTER TABLE `__new_purchase_orders` RENAME TO `purchase_orders`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_tenant_no` ON `purchase_orders` (`tenant_id`,`order_no`);--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_tenant_status` ON `purchase_orders` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`site_id` text NOT NULL,
	`settlement_month` text NOT NULL,
	`actual_servings` integer NOT NULL,
	`sales_amount` integer NOT NULL,
	`ingredient_cost` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`site_id`) REFERENCES `sites`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_settlements`("id", "tenant_id", "site_id", "settlement_month", "actual_servings", "sales_amount", "ingredient_cost", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "site_id", "settlement_month", "actual_servings", "sales_amount", "ingredient_cost", "status", "created_at", "updated_at" FROM `settlements`;--> statement-breakpoint
DROP TABLE `settlements`;--> statement-breakpoint
ALTER TABLE `__new_settlements` RENAME TO `settlements`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_settlements_tenant_site_month` ON `settlements` (`tenant_id`,`site_id`,`settlement_month`);--> statement-breakpoint
CREATE INDEX `idx_settlements_tenant_month` ON `settlements` (`tenant_id`,`settlement_month`);