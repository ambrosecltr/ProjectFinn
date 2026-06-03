CREATE TYPE "public"."automation_run_state" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."automation_run_type" AS ENUM('my_day_refresh', 'personal_intelligence');--> statement-breakpoint
CREATE TYPE "public"."my_day_todo_status" AS ENUM('open', 'done', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."pattern_run_state" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pattern_run_trigger" AS ENUM('schedule', 'composio', 'manual');--> statement-breakpoint
CREATE TYPE "public"."pattern_trigger_type" AS ENUM('schedule', 'composio');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_source" AS ENUM('user', 'worker', 'trigger', 'system');--> statement-breakpoint
CREATE TYPE "public"."worker_state" AS ENUM('created', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."worker_type" AS ENUM('general', 'pattern_management', 'pattern_worker', 'reminder');--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_type" "automation_run_type" NOT NULL,
	"state" "automation_run_state" NOT NULL,
	"user_local_date" text,
	"toolkit_slug" text,
	"account_scope_id" text,
	"connected_account_id" text,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"contributor_status" jsonb,
	"result_summary" text,
	"accepted_todo_ids" jsonb,
	"retained_document_ids" jsonb,
	"skipped_reasons" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"root_conversation_id" text NOT NULL,
	"previous_conversation_id" text,
	"chapter_index" integer DEFAULT 1 NOT NULL,
	"user_local_date" text NOT NULL,
	"handoff_summary" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"user_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"folder_id" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"user_visible" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" jsonb NOT NULL,
	"always_on" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"source" "message_source" NOT NULL,
	"source_message_id" text,
	"tool_calls" jsonb,
	"token_estimate" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"compacted" boolean DEFAULT false NOT NULL,
	"compaction_group" text
);
--> statement-breakpoint
CREATE TABLE "my_day_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_local_date" text NOT NULL,
	"timezone" text NOT NULL,
	"summary" text,
	"source_summary" text,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "my_day_todos" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"my_day_id" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" "my_day_todo_status" DEFAULT 'open' NOT NULL,
	"source" jsonb,
	"handoff_at" timestamp with time zone,
	"handoff_worker_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pattern_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"pattern_id" text NOT NULL,
	"triggered_by" "pattern_run_trigger" NOT NULL,
	"trigger_payload" jsonb,
	"worker_id" text,
	"state" "pattern_run_state" NOT NULL,
	"result" jsonb,
	"notify_outcome" jsonb,
	"surfaced_at" timestamp with time zone,
	"tool_scope" jsonb,
	"error" text,
	"skip_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"user_description" text,
	"trigger_type" "pattern_trigger_type" NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"connector_scope" jsonb NOT NULL,
	"trigger_filters" jsonb NOT NULL,
	"notify_condition" jsonb NOT NULL,
	"worker_type" "worker_type" NOT NULL,
	"task_prompt" text NOT NULL,
	"reminder_context" jsonb,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_intelligence_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"toolkit_slug" text NOT NULL,
	"account_scope_id" text NOT NULL,
	"provider_account_type" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_workspace_type" text,
	"provider_workspace_id" text,
	"current_connected_account_id" text,
	"identity_status" text NOT NULL,
	"display_name" text,
	"email" text,
	"handle" text,
	"verified_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_intelligence_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"toolkit_slug" text NOT NULL,
	"account_scope_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"source_type" text NOT NULL,
	"coverage_start" timestamp with time zone,
	"coverage_end" timestamp with time zone,
	"last_processed_source_timestamp" timestamp with time zone,
	"source_cursor" text,
	"initial_backfill_completed_at" timestamp with time zone,
	"last_successful_run_id" text,
	"last_explored_entities" jsonb,
	"known_gaps" jsonb,
	"handoff_summary" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_intelligence_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"toolkit_slug" text NOT NULL,
	"account_scope_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"retained_document_id" text NOT NULL,
	"title" text,
	"source_url" text,
	"source_timestamp" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_address" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_connector_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"toolkit_slug" text NOT NULL,
	"toolkit_name" text,
	"connected" boolean DEFAULT false NOT NULL,
	"connected_account_id" text,
	"connection_status" text,
	"permission_mode" text DEFAULT 'all' NOT NULL,
	"my_day_enabled" boolean DEFAULT false NOT NULL,
	"personal_intelligence_enabled" boolean DEFAULT false NOT NULL,
	"enabled_tools" jsonb,
	"last_notified_connected_account_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"display_name" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"location" text,
	"identity" text DEFAULT '' NOT NULL,
	"kids_mode" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_login_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" "worker_type" NOT NULL,
	"task" text NOT NULL,
	"state" "worker_state" NOT NULL,
	"run_sequence" integer DEFAULT 1 NOT NULL,
	"origin_message_id" text,
	"completion_delivered_at" timestamp with time zone,
	"status_detail" text,
	"tool_calls_used" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"model_messages" jsonb,
	"follow_up_expires_at" timestamp with time zone,
	"parent_conversation_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "file_folders_id_owner_unique_idx" ON "file_folders" USING btree ("id","tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "my_day_entries_id_owner_unique_idx" ON "my_day_entries" USING btree ("id","tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_folders" ADD CONSTRAINT "file_folders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_folders" ADD CONSTRAINT "file_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_folders" ADD CONSTRAINT "file_folders_owner_parent_fk" FOREIGN KEY ("parent_id","tenant_id","user_id") REFERENCES "public"."file_folders"("id","tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_file_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."file_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "my_day_entries" ADD CONSTRAINT "my_day_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "my_day_entries" ADD CONSTRAINT "my_day_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "my_day_todos" ADD CONSTRAINT "my_day_todos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "my_day_todos" ADD CONSTRAINT "my_day_todos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "my_day_todos" ADD CONSTRAINT "my_day_todos_owner_day_fk" FOREIGN KEY ("my_day_id","tenant_id","user_id") REFERENCES "public"."my_day_entries"("id","tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_runs" ADD CONSTRAINT "pattern_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_runs" ADD CONSTRAINT "pattern_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_runs" ADD CONSTRAINT "pattern_runs_pattern_id_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."patterns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_runs" ADD CONSTRAINT "pattern_runs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patterns" ADD CONSTRAINT "patterns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patterns" ADD CONSTRAINT "patterns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_accounts" ADD CONSTRAINT "personal_intelligence_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_accounts" ADD CONSTRAINT "personal_intelligence_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_checkpoints" ADD CONSTRAINT "personal_intelligence_checkpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_checkpoints" ADD CONSTRAINT "personal_intelligence_checkpoints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_checkpoints" ADD CONSTRAINT "personal_intelligence_checkpoints_last_successful_run_id_automation_runs_id_fk" FOREIGN KEY ("last_successful_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_sources" ADD CONSTRAINT "personal_intelligence_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_sources" ADD CONSTRAINT "personal_intelligence_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_intelligence_sources" ADD CONSTRAINT "personal_intelligence_sources_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connector_configs" ADD CONSTRAINT "user_connector_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connector_configs" ADD CONSTRAINT "user_connector_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_login_codes" ADD CONSTRAINT "web_login_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_parent_conversation_id_conversations_id_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_owner_idx" ON "automation_runs" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "automation_runs_type_created_idx" ON "automation_runs" USING btree ("run_type","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_owner_type_created_idx" ON "automation_runs" USING btree ("tenant_id","user_id","run_type","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_owner_type_connector_completed_idx" ON "automation_runs" USING btree ("tenant_id","user_id","run_type","toolkit_slug","connected_account_id","completed_at");--> statement-breakpoint
CREATE INDEX "automation_runs_owner_type_account_scope_completed_idx" ON "automation_runs" USING btree ("tenant_id","user_id","run_type","toolkit_slug","account_scope_id","completed_at");--> statement-breakpoint
CREATE INDEX "conversations_owner_idx" ON "conversations" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "conversations_root_conversation_id_idx" ON "conversations" USING btree ("root_conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_active_idx" ON "conversations" USING btree ("tenant_id","user_id","active");--> statement-breakpoint
CREATE INDEX "conversations_user_local_date_idx" ON "conversations" USING btree ("user_local_date");--> statement-breakpoint
CREATE INDEX "events_owner_idx" ON "events" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "events_processed_idx" ON "events" USING btree ("processed");--> statement-breakpoint
CREATE INDEX "file_folders_owner_idx" ON "file_folders" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "file_folders_parent_idx" ON "file_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_folders_root_name_unique_idx" ON "file_folders" USING btree ("tenant_id","user_id","name") WHERE "file_folders"."parent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "file_folders_child_name_unique_idx" ON "file_folders" USING btree ("tenant_id","user_id","parent_id","name") WHERE "file_folders"."parent_id" is not null;--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "files" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "files_folder_idx" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "files_owner_updated_idx" ON "files" USING btree ("tenant_id","user_id","updated_at","created_at","id");--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_idx" ON "mcp_servers" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_owner_name_unique_idx" ON "mcp_servers" USING btree ("tenant_id","user_id","name");--> statement-breakpoint
CREATE INDEX "messages_owner_idx" ON "messages" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_source_message_id_idx" ON "messages" USING btree ("tenant_id","user_id","source_message_id");--> statement-breakpoint
CREATE INDEX "my_day_entries_owner_idx" ON "my_day_entries" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "my_day_entries_owner_date_unique_idx" ON "my_day_entries" USING btree ("tenant_id","user_id","user_local_date");--> statement-breakpoint
CREATE INDEX "my_day_todos_owner_idx" ON "my_day_todos" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "my_day_todos_day_idx" ON "my_day_todos" USING btree ("my_day_id");--> statement-breakpoint
CREATE INDEX "my_day_todos_handoff_worker_idx" ON "my_day_todos" USING btree ("handoff_worker_id");--> statement-breakpoint
CREATE INDEX "pattern_runs_owner_idx" ON "pattern_runs" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "pattern_runs_pattern_idx" ON "pattern_runs" USING btree ("pattern_id");--> statement-breakpoint
CREATE INDEX "pattern_runs_worker_idx" ON "pattern_runs" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "patterns_owner_idx" ON "patterns" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "patterns_due_idx" ON "patterns" USING btree ("active","next_run_at");--> statement-breakpoint
CREATE INDEX "patterns_composio_trigger_idx" ON "patterns" USING btree (("trigger_config"->>'triggerId'));--> statement-breakpoint
CREATE INDEX "patterns_connected_account_idx" ON "patterns" USING btree (("trigger_config"->>'connectedAccountId'));--> statement-breakpoint
CREATE INDEX "personal_intelligence_accounts_owner_idx" ON "personal_intelligence_accounts" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_intelligence_accounts_scope_unique_idx" ON "personal_intelligence_accounts" USING btree ("tenant_id","user_id","toolkit_slug","account_scope_id");--> statement-breakpoint
CREATE INDEX "personal_intelligence_accounts_current_connected_idx" ON "personal_intelligence_accounts" USING btree ("tenant_id","user_id","toolkit_slug","current_connected_account_id");--> statement-breakpoint
CREATE INDEX "personal_intelligence_checkpoints_owner_idx" ON "personal_intelligence_checkpoints" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_intelligence_checkpoints_owner_account_scope_unique_idx" ON "personal_intelligence_checkpoints" USING btree ("tenant_id","user_id","toolkit_slug","account_scope_id","source_type");--> statement-breakpoint
CREATE INDEX "personal_intelligence_sources_owner_idx" ON "personal_intelligence_sources" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "personal_intelligence_sources_owner_created_idx" ON "personal_intelligence_sources" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "personal_intelligence_sources_source_hash_idx" ON "personal_intelligence_sources" USING btree ("tenant_id","user_id","source_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_intelligence_sources_account_scope_source_unique_idx" ON "personal_intelligence_sources" USING btree ("tenant_id","user_id","toolkit_slug","account_scope_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "user_channels_user_id_idx" ON "user_channels" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_channels_provider_address_unique_idx" ON "user_channels" USING btree ("tenant_id","provider","external_address");--> statement-breakpoint
CREATE INDEX "user_connector_configs_owner_idx" ON "user_connector_configs" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_connector_configs_owner_toolkit_unique_idx" ON "user_connector_configs" USING btree ("tenant_id","user_id","toolkit_slug");--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_phone_number_unique_idx" ON "users" USING btree ("tenant_id","phone_number");--> statement-breakpoint
CREATE INDEX "web_login_codes_phone_idx" ON "web_login_codes" USING btree ("tenant_id","phone_number");--> statement-breakpoint
CREATE INDEX "web_login_codes_expires_at_idx" ON "web_login_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_token_hash_unique_idx" ON "web_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "web_sessions_user_idx" ON "web_sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "web_sessions_expires_at_idx" ON "web_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workers_owner_idx" ON "workers" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "workers_origin_message_id_idx" ON "workers" USING btree ("tenant_id","user_id","origin_message_id");--> statement-breakpoint
CREATE INDEX "workers_state_idx" ON "workers" USING btree ("tenant_id","user_id","state");--> statement-breakpoint
CREATE INDEX "workers_follow_up_expires_at_idx" ON "workers" USING btree ("tenant_id","user_id","follow_up_expires_at");
