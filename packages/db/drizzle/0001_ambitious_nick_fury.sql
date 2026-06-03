CREATE TABLE "connector_catalog" (
	"toolkit_slug" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"logo_path" text,
	"logo_url" text,
	"source" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connector_catalog_source_check" CHECK ("source" IN ('admin', 'composio'))
);
