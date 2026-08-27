CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_tenant_created` ON `audit_logs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deliveries` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_deliveries_tenant_no` ON `deliveries` (`tenant_id`,`delivery_no`);--> statement-breakpoint
CREATE INDEX `idx_deliveries_tenant_status` ON `deliveries` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `haccp_checks` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_haccp_checks_tenant_date` ON `haccp_checks` (`tenant_id`,`check_date`);--> statement-breakpoint
CREATE INDEX `idx_haccp_checks_tenant_status` ON `haccp_checks` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inventory_lots` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inventory_lots_tenant_lot` ON `inventory_lots` (`tenant_id`,`lot_no`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lots_tenant_expiry` ON `inventory_lots` (`tenant_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lots_tenant_status` ON `inventory_lots` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `meal_plans` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_meal_plans_tenant_date` ON `meal_plans` (`tenant_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `idx_meal_plans_tenant_status` ON `meal_plans` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `production_orders` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_production_orders_tenant_date` ON `production_orders` (`tenant_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `idx_production_orders_tenant_status` ON `production_orders` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_orders_tenant_no` ON `purchase_orders` (`tenant_id`,`order_no`);--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_tenant_status` ON `purchase_orders` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `settlements` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_settlements_tenant_site_month` ON `settlements` (`tenant_id`,`site_id`,`settlement_month`);--> statement-breakpoint
CREATE INDEX `idx_settlements_tenant_month` ON `settlements` (`tenant_id`,`settlement_month`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Seoul' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sites_tenant_code` ON `sites` (`tenant_id`,`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sites_tenant_id` ON `sites` (`tenant_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sites_tenant` ON `sites` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`brand_color` text DEFAULT '#17324D' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tenants_code` ON `tenants` (`code`);