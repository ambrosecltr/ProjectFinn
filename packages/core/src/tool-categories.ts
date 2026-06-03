export const toolCategoryTools = {
  hotpath_core: ["send_message", "send_media", "display_draft", "react", "wait", "finish_turn", "delegate", "cancel_worker", "update_user_profile", "list_active_patterns"],
  memory: ["search_memory", "reflect_memory"],
  reminders: ["list_reminders", "inspect_reminder", "create_reminder", "edit_reminder", "delete_reminder"],
  todos: ["list_my_day_todos", "add_my_day_todo", "update_my_day_todo", "delete_my_day_todo"],
  worker_core: ["set_status"],
  personal_intelligence_core: ["retain_personal_intelligence_item", "finish_personal_intelligence_run"],
  my_day_core: ["update_my_day_summary", "create_my_day_todo", "edit_my_day_todo", "archive_my_day_todo"],
  js_workspace: ["workspace_search", "workspace_execute", "view_image"],

  hotpath_delivery: ["send_message", "send_media", "display_draft"],
  hotpath_turn_control: ["wait", "finish_turn"],
  hotpath_delegation_ack: ["send_message", "wait", "finish_turn"],
  hotpath_delegate: ["delegate"],
  hotpath_worker_control: ["cancel_worker"],
  hotpath_memory: ["search_memory", "reflect_memory"],
  hotpath_file_context: ["workspace_search", "workspace_execute", "view_image"],
  hotpath_reactions: ["react"],
  hotpath_profile: ["update_user_profile"],
  hotpath_pattern_context: ["list_active_patterns"],
  hotpath_reminder_read: ["list_reminders", "inspect_reminder"],
  hotpath_reminder_write: ["create_reminder", "edit_reminder", "delete_reminder"],
  hotpath_my_day_read: ["list_my_day_todos"],
  hotpath_my_day_write: ["add_my_day_todo", "update_my_day_todo", "delete_my_day_todo"],
  hotpath_my_day_completion: ["update_my_day_todo"],

  web: ["finn.web.search", "finn.web.fetch"],
  creative: ["finn.creative.image", "finn.creative.video"],
  files: ["finn.files.list", "finn.files.read", "finn.files.search", "finn.files.extract", "finn.files.viewImage", "finn.files.write", "finn.files.download", "finn.files.setVisibility"],
  workspace_execute: ["workspace_search", "workspace_execute"],
  workspace_patch: ["finn.files.patch"],
  skills: [
    "list_installed_skills",
    "search_skills_sh",
    "install_skill_from_skills_sh",
    "remove_installed_skill",
    "update_installed_skill",
    "load_skill",
    "read_skill_resource",
  ],
  memory_user: ["search_memory", "reflect_memory"],
  memory_pattern: ["search_memory", "reflect_memory"],
  composio: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"],
  mcp: ["finn.mcp.servers", "finn.mcp.search", "finn.mcp.resources", "finn.mcp.readResource", "finn.mcp.call"],
  pattern_management: [
    "finn.patterns.list",
    "finn.patterns.triggerTypes",
    "finn.patterns.triggerType",
    "finn.patterns.create",
    "finn.patterns.inspect",
    "finn.patterns.edit",
    "finn.patterns.pause",
    "finn.patterns.resume",
    "finn.patterns.delete",
  ],
  pattern_history: ["finn.pattern.runs", "finn.pattern.run"],
  worker_status: ["set_status"],
  automation_memory: ["search_memory"],
  my_day_internal: ["update_my_day_summary", "create_my_day_todo", "edit_my_day_todo", "archive_my_day_todo"],
  personal_intelligence_internal: ["retain_personal_intelligence_item", "finish_personal_intelligence_run"],
} as const satisfies Record<string, readonly string[]>;

export type ToolCategory = keyof typeof toolCategoryTools;
export type ToolName = (typeof toolCategoryTools)[ToolCategory][number];

export function toolNamesForCategories(categories: readonly ToolCategory[]): string[] {
  const names = new Set<string>();
  for (const category of categories) {
    for (const name of toolCategoryTools[category]) {
      names.add(name);
    }
  }
  return [...names];
}

export function activeToolNamesForCategories(
  availableTools: Record<string, unknown>,
  categories: readonly ToolCategory[],
): string[] {
  return toolNamesForCategories(categories).filter((name) => Boolean(availableTools[name]));
}

export function toolCategoriesForName(toolName: string): ToolCategory[] {
  return (Object.keys(toolCategoryTools) as ToolCategory[])
    .filter((category) => toolCategoryTools[category].includes(toolName as never));
}
