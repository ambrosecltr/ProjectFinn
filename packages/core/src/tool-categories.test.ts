import { describe, expect, it } from "bun:test";

import {
  activeToolNamesForCategories,
  toolCategoriesForName,
  toolCategoryTools,
  toolNamesForCategories,
} from "./tool-categories.js";

describe("tool categories", () => {
  it("maps the agreed top-level native tool groups", () => {
    expect(toolCategoryTools.hotpath_core).toEqual(["send_message", "send_media", "display_draft", "react", "wait", "finish_turn", "delegate", "cancel_worker", "update_user_profile", "list_active_patterns"]);
    expect(toolCategoryTools.memory).toEqual(["search_memory", "reflect_memory"]);
    expect(toolCategoryTools.reminders).toEqual(["list_reminders", "inspect_reminder", "create_reminder", "edit_reminder", "delete_reminder"]);
    expect(toolCategoryTools.todos).toEqual(["list_my_day_todos", "add_my_day_todo", "update_my_day_todo", "delete_my_day_todo"]);
    expect(toolCategoryTools.worker_core).toEqual(["set_status"]);
    expect(toolCategoryTools.personal_intelligence_core).toEqual(["retain_personal_intelligence_item", "finish_personal_intelligence_run"]);
    expect(toolCategoryTools.my_day_core).toEqual(["update_my_day_summary", "create_my_day_todo", "edit_my_day_todo", "archive_my_day_todo"]);
    expect(toolCategoryTools.js_workspace).toEqual(["workspace_search", "workspace_execute", "view_image"]);
  });

  it("maps hot-path categories to the agreed origin-policy tool families", () => {
    expect(toolCategoryTools.hotpath_delivery).toEqual(["send_message", "send_media", "display_draft"]);
    expect(toolCategoryTools.hotpath_turn_control).toEqual(["wait", "finish_turn"]);
    expect(toolCategoryTools.hotpath_delegation_ack).toEqual(["send_message", "wait", "finish_turn"]);
    expect(toolCategoryTools.hotpath_delegate).toEqual(["delegate"]);
    expect(toolCategoryTools.hotpath_worker_control).toEqual(["cancel_worker"]);
    expect(toolCategoryTools.hotpath_file_context).toEqual(["workspace_search", "workspace_execute", "view_image"]);
    expect(toolCategoryTools.hotpath_reactions).toEqual(["react"]);
    expect(toolCategoryTools.hotpath_profile).toEqual(["update_user_profile"]);
    expect(toolCategoryTools.hotpath_pattern_context).toEqual(["list_active_patterns"]);
    expect(toolCategoryTools.hotpath_reminder_read).toEqual(["list_reminders", "inspect_reminder"]);
    expect(toolCategoryTools.hotpath_reminder_write).toEqual(["create_reminder", "edit_reminder", "delete_reminder"]);
    expect(toolCategoryTools.hotpath_reminder_read).not.toContain("create_reminder");
    expect(toolCategoryTools.hotpath_reminder_write).not.toContain("list_reminders");
    expect(toolCategoryTools.hotpath_my_day_read).toEqual(["list_my_day_todos"]);
    expect(toolCategoryTools.hotpath_my_day_write).toEqual(["add_my_day_todo", "update_my_day_todo", "delete_my_day_todo"]);
    expect(toolCategoryTools.hotpath_my_day_completion).toEqual(["update_my_day_todo"]);
    expect(toolCategoryTools.hotpath_my_day_read).not.toContain("add_my_day_todo");
    expect(toolCategoryTools.hotpath_my_day_write).not.toContain("list_my_day_todos");
  });

  it("maps worker and internal automation categories", () => {
    expect(toolCategoryTools.web).toEqual(["finn.web.search", "finn.web.fetch"]);
    expect(toolCategoryTools.files).toEqual(["finn.files.list", "finn.files.read", "finn.files.search", "finn.files.extract", "finn.files.write", "finn.files.download", "finn.files.setVisibility"]);
    expect(toolCategoryTools.workspace_execute).toEqual(["workspace_search", "workspace_execute"]);
    expect(toolCategoryTools.workspace_patch).toEqual(["finn.files.patch"]);
    expect(toolCategoryTools.memory_user).toEqual(["search_memory", "reflect_memory"]);
    expect(toolCategoryTools.memory_pattern).toEqual(["search_memory", "reflect_memory"]);
    expect(toolCategoryTools.composio).toEqual(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"]);
    expect(toolCategoryTools.pattern_management).toContain("finn.patterns.pause");
    expect(toolCategoryTools.pattern_management).toContain("finn.patterns.resume");
    expect(toolCategoryTools.pattern_management).not.toContain("toggle_pattern");
    expect(toolCategoryTools.worker_status).toEqual(["set_status"]);
    expect(toolCategoryTools.automation_memory).toEqual(["search_memory"]);
    expect(toolCategoryTools.my_day_internal).toEqual(["update_my_day_summary", "create_my_day_todo", "edit_my_day_todo", "archive_my_day_todo"]);
    expect(toolCategoryTools.personal_intelligence_internal).toEqual(["retain_personal_intelligence_item", "finish_personal_intelligence_run"]);
  });

  it("dedupes category expansion and filters to available tools", () => {
    expect(toolNamesForCategories(["hotpath_my_day_write", "hotpath_my_day_completion"]))
      .toEqual(["add_my_day_todo", "update_my_day_todo", "delete_my_day_todo"]);
    expect(activeToolNamesForCategories({
      send_message: {},
      wait: {},
      finish_turn: {},
    }, ["hotpath_delivery", "hotpath_turn_control"])).toEqual(["send_message", "wait", "finish_turn"]);
  });

  it("can reverse-map tool names to categories", () => {
    expect(toolCategoriesForName("update_my_day_todo")).toEqual(["todos", "hotpath_my_day_write", "hotpath_my_day_completion"]);
    expect(toolCategoriesForName("cancel_worker")).toEqual(["hotpath_core", "hotpath_worker_control"]);
    expect(toolCategoriesForName("finn.mcp.call")).toEqual(["mcp"]);
    expect(toolCategoriesForName("finn.files.list")).toEqual(["files"]);
  });
});
