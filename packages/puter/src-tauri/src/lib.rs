use chrono::{DateTime, FixedOffset};
use flate2::read::GzDecoder;
use futures_util::{SinkExt, StreamExt};
use reqwest::{
    header::{COOKIE, SET_COOKIE},
    Client, RequestBuilder,
};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{interval, sleep, timeout, MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message as WebSocketMessage};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{Bool, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2::{AnyThread, Message};
#[cfg(target_os = "macos")]
use objc2_contacts::{
    CNAuthorizationStatus, CNContact, CNContactEmailAddressesKey, CNContactFamilyNameKey,
    CNContactFetchRequest, CNContactGivenNameKey, CNContactMiddleNameKey, CNContactNicknameKey,
    CNContactOrganizationNameKey, CNContactPhoneNumbersKey, CNContactStore, CNEntityType,
    CNKeyDescriptor,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSError};

const KEYCHAIN_SERVICE: &str = "ai.finn.puter";
const KEYCHAIN_SESSION_ACCOUNT: &str = "finn_session";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const LOCAL_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const BASE64_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const SOCKET_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const SOCKET_CONFIG_SYNC_INTERVAL: Duration = Duration::from_secs(30);
const SOCKET_ACCESS_STATUS_INTERVAL: Duration = Duration::from_secs(600);
const ACTIVITY_WINDOW_LABEL: &str = "puter-activity";
const ACTIVITY_WINDOW_WIDTH: f64 = 324.0;
const ACTIVITY_WINDOW_HEIGHT: f64 = 95.0;
const ACTIVITY_WINDOW_MARGIN: f64 = 0.0;
const ACTIVITY_NATIVE_HIDE_DELAY: Duration = Duration::from_millis(8_320);

struct PuterState {
    config: Mutex<StoredPuterConfig>,
    client: Client,
    socket_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    socket_outbox: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    socket_status: Mutex<SocketStatusEvent>,
    activity_generation: AtomicU64,
    last_activity_message: StdMutex<Option<String>>,
}

impl PuterState {
    fn new() -> Self {
        Self {
            config: Mutex::new(load_stored_config()),
            client: Client::builder()
                .build()
                .expect("failed to build HTTP client"),
            socket_task: Mutex::new(None),
            socket_outbox: Mutex::new(None),
            socket_status: Mutex::new(SocketStatusEvent {
                connected: false,
                message: "Disconnected from Finn.".to_string(),
            }),
            activity_generation: AtomicU64::new(0),
            last_activity_message: StdMutex::new(None),
        }
    }
}

struct FinnPuterTray {
    _tray: TrayIcon,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct StoredPuterConfig {
    host: Option<String>,
    device_id: Option<String>,
    #[serde(default)]
    setup_completed: bool,
}

#[derive(Debug, Default, Deserialize)]
struct LegacyStoredPuterConfig {
    host: Option<String>,
    device_id: Option<String>,
    session_token: Option<String>,
    setup_completed: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPuterState {
    host: Option<String>,
    setup_completed: bool,
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    phone_number: String,
}

#[derive(Debug, Deserialize)]
struct VerifyRequest {
    phone_number: String,
    code: String,
}

#[derive(Debug, Deserialize)]
struct PuterConfigPatch {
    device_id: String,
    imessage_enabled: Option<bool>,
    imessage_personal_intelligence_enabled: Option<bool>,
    notes_enabled: Option<bool>,
    notes_personal_intelligence_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SyncRequest {
    device_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SocketStatusEvent {
    connected: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandActivityEvent {
    active: bool,
    message: String,
    generation: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionCheck {
    granted: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactIdentity {
    handle: String,
    display_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentMetadata {
    attachment_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transfer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uti: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    missing: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRecord {
    source_type: String,
    source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_contact: Option<ContactIdentity>,
    recipients: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    recipient_contacts: Vec<ContactIdentity>,
    title: String,
    timestamp: String,
    content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<AttachmentMetadata>,
    metadata: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLocalRecord {
    source_type: String,
    source_id: String,
    message_id: Option<String>,
    thread_id: Option<String>,
    sender: Option<String>,
    recipients: Option<Value>,
    title: Option<String>,
    timestamp: Option<String>,
    content: Option<String>,
    attributed_body_hex: Option<String>,
    attachments: Option<Value>,
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNoteRow {
    row_id: i64,
    source_id: String,
    title: String,
    folder: String,
    timestamp: String,
    data_hex: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAttachmentMetadata {
    attachment_id: i64,
    guid: Option<String>,
    filename: Option<String>,
    transfer_name: Option<String>,
    uti: Option<String>,
    mime_type: Option<String>,
    total_bytes: Option<i64>,
}

#[derive(Debug, Default)]
struct ContactContext {
    contact_names: HashMap<String, String>,
    local_handles: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeCommand {
    id: String,
    toolset: String,
    command: String,
    args: Value,
    window_start: String,
    window_end: String,
    #[serde(default)]
    excluded_handles: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketTokenResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketIncomingMessage {
    #[serde(rename = "type")]
    message_type: String,
    command: Option<BridgeCommand>,
    config: Option<Value>,
}

#[tauri::command]
async fn saved_puter_state(state: State<'_, PuterState>) -> Result<SavedPuterState, String> {
    let config = state.config.lock().await;
    Ok(SavedPuterState {
        host: config.host.clone(),
        setup_completed: config.setup_completed,
    })
}

#[tauri::command]
async fn configure_host(host: String, state: State<'_, PuterState>) -> Result<String, String> {
    let normalized = normalize_host(&host)?;
    {
        let mut config = state.config.lock().await;
        apply_configured_host(&mut config, normalized.clone())?;
        save_stored_config(&config)?;
    }
    Ok(normalized)
}

#[tauri::command]
async fn complete_setup(state: State<'_, PuterState>) -> Result<(), String> {
    let mut config = state.config.lock().await;
    config.setup_completed = true;
    save_stored_config(&config)
}

#[tauri::command]
async fn request_login(input: LoginRequest, state: State<'_, PuterState>) -> Result<(), String> {
    let host = require_host(&state).await?;
    let response = state
        .client
        .post(format!("{host}/api/web/auth/request"))
        .json(&serde_json::json!({ "phoneNumber": input.phone_number }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    ensure_success(response).await.map(|_| ())
}

#[tauri::command]
async fn verify_login(input: VerifyRequest, state: State<'_, PuterState>) -> Result<Value, String> {
    let host = require_host(&state).await?;
    let response = state
        .client
        .post(format!("{host}/api/web/auth/verify"))
        .json(&serde_json::json!({ "phoneNumber": input.phone_number, "code": input.code }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    persist_session_cookie(&state, &response).await?;
    ensure_success(response).await
}

#[tauri::command]
async fn fetch_session(state: State<'_, PuterState>) -> Result<Value, String> {
    let host = require_host(&state).await?;
    let response = with_session_cookie(&state, state.client.get(format!("{host}/api/web/session")))
        .await
        .send()
        .await
        .map_err(|error| error.to_string())?;
    ensure_success(response).await
}

#[tauri::command]
async fn sign_out(state: State<'_, PuterState>) -> Result<(), String> {
    let host = state.config.lock().await.host.clone();
    if let Some(host) = host {
        let _ = with_session_cookie(
            &state,
            state.client.post(format!("{host}/api/web/auth/logout")),
        )
        .await
        .send()
        .await;
    }
    {
        delete_session_token()?;
    }
    Ok(())
}

#[tauri::command]
async fn check_authorization(scope: String) -> Result<PermissionCheck, String> {
    match scope.as_str() {
        "imessage" => Ok(check_imessage_access()),
        "accessibility" => Ok(check_accessibility_access()),
        "contacts" => Ok(check_contacts_access()),
        "notes" => Ok(check_notes_access()),
        _ => Err("Unsupported authorization scope.".to_string()),
    }
}

#[tauri::command]
async fn request_authorization(scope: String) -> Result<PermissionCheck, String> {
    match scope.as_str() {
        "contacts" => Ok(request_contacts_access().await),
        "notes" => Ok(check_notes_access()),
        "imessage" => Ok(check_imessage_access()),
        "accessibility" => Ok(check_accessibility_access()),
        _ => Err("Unsupported authorization scope.".to_string()),
    }
}

#[tauri::command]
async fn open_privacy_pane(pane: String) -> Result<(), String> {
    let pane = match pane.as_str() {
        "Privacy_AllFiles" | "Privacy_Accessibility" | "Privacy_Contacts" => pane,
        _ => return Err("Unsupported privacy pane.".to_string()),
    };
    Command::new("open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?{pane}"
        ))
        .status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn update_puter_config(
    input: PuterConfigPatch,
    state: State<'_, PuterState>,
) -> Result<Value, String> {
    let host = require_host(&state).await?;
    let mut puter = serde_json::Map::new();
    puter.insert("deviceId".to_string(), serde_json::json!(input.device_id));
    if let Some(enabled) = input.imessage_enabled {
        puter.insert("imessageEnabled".to_string(), serde_json::json!(enabled));
    }
    if let Some(enabled) = input.imessage_personal_intelligence_enabled {
        puter.insert(
            "imessagePersonalIntelligenceEnabled".to_string(),
            serde_json::json!(enabled),
        );
    }
    if let Some(enabled) = input.notes_enabled {
        puter.insert("notesEnabled".to_string(), serde_json::json!(enabled));
    }
    if let Some(enabled) = input.notes_personal_intelligence_enabled {
        puter.insert(
            "notesPersonalIntelligenceEnabled".to_string(),
            serde_json::json!(enabled),
        );
    }

    let response = with_session_cookie(
        &state,
        state
            .client
            .patch(format!("{host}/api/web/connectors/puter/config"))
            .json(&serde_json::json!({ "puter": puter })),
    )
    .await
    .send()
    .await
    .map_err(|error| error.to_string())?;
    ensure_success(response).await
}

#[tauri::command]
async fn fetch_puter_config(state: State<'_, PuterState>) -> Result<Value, String> {
    let host = require_host(&state).await?;
    let response = with_session_cookie(
        &state,
        state.client.get(format!("{host}/api/web/connectors/puter")),
    )
    .await
    .send()
    .await
    .map_err(|error| error.to_string())?;
    ensure_success(response).await
}

#[tauri::command]
async fn socket_status(state: State<'_, PuterState>) -> Result<SocketStatusEvent, String> {
    Ok(state.socket_status.lock().await.clone())
}

#[tauri::command]
async fn sync_access_status(state: State<'_, PuterState>) -> Result<(), String> {
    send_socket_message(&state, local_access_status_message()).await
}

#[tauri::command]
async fn connect_puter_socket(
    input: SyncRequest,
    state: State<'_, PuterState>,
    app: AppHandle,
) -> Result<(), String> {
    let host = require_host(&state).await?;
    let client = state.client.clone();
    let device_id = input.device_id;
    let session_token = require_session_token(&state).await?;

    emit_socket_status(&app, false, "Connecting to Finn.").await;

    let mut socket_task = state.socket_task.lock().await;
    if let Some(handle) = socket_task.take() {
        handle.abort();
    }
    let (socket_sender, socket_receiver) = mpsc::unbounded_channel();
    *state.socket_outbox.lock().await = Some(socket_sender);
    let app_for_task = app.clone();
    *socket_task = Some(tauri::async_runtime::spawn(async move {
        run_puter_socket_loop(
            host,
            client,
            session_token,
            device_id,
            app_for_task,
            socket_receiver,
        )
        .await;
    }));
    Ok(())
}

#[tauri::command]
async fn disconnect_puter_socket(
    state: State<'_, PuterState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut socket_task = state.socket_task.lock().await;
    if let Some(handle) = socket_task.take() {
        handle.abort();
    }
    *state.socket_outbox.lock().await = None;
    emit_socket_status(&app, false, "Disconnected from Finn.").await;
    Ok(())
}

#[tauri::command]
async fn device_id(state: State<'_, PuterState>) -> Result<String, String> {
    let mut config = state.config.lock().await;
    if let Some(device_id) = config
        .device_id
        .clone()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(device_id);
    }

    let device_id = format!("mac-{}", Uuid::new_v4());
    config.device_id = Some(device_id.clone());
    save_stored_config(&config)?;
    Ok(device_id)
}

const IMESSAGE_MESSAGE_VISIBILITY_COLUMNS: &[&str] = &[
    "is_archive",
    "is_deleted",
    "date_deleted",
    "date_retracted",
    "is_spam",
];
const IMESSAGE_CHAT_VISIBILITY_COLUMNS: &[&str] =
    &["is_archived", "is_blackholed", "is_deleted", "date_deleted"];

fn read_imessage_records(command: &BridgeCommand) -> Result<Vec<LocalRecord>, String> {
    let chat_db = home_path("Library/Messages/chat.db")?;
    if !chat_db.exists() {
        return Ok(Vec::new());
    }

    let destination_caller = if sqlite_column_exists(&chat_db, "message", "destination_caller_id") {
        "message.destination_caller_id"
    } else {
        "''"
    };
    let reaction_filter = if sqlite_column_exists(&chat_db, "message", "associated_message_type") {
        "and (message.associated_message_type is null or message.associated_message_type < 2000 or message.associated_message_type > 3006)"
    } else {
        ""
    };
    let message_visibility_filter =
        sqlite_zero_or_missing_filter(&chat_db, "message", IMESSAGE_MESSAGE_VISIBILITY_COLUMNS);
    let chat_visibility_filter =
        sqlite_zero_or_missing_filter(&chat_db, "chat", IMESSAGE_CHAT_VISIBILITY_COLUMNS);
    let recoverable_message_filter = if sqlite_table_exists(
        &chat_db,
        "chat_recoverable_message_join",
    ) {
        "and not exists (select 1 from chat_recoverable_message_join recoverable_join where recoverable_join.message_id = message.ROWID)"
    } else {
        ""
    };
    let message_is_archive = sqlite_optional_column(&chat_db, "message", "is_archive", "0");
    let message_is_deleted = sqlite_optional_column(&chat_db, "message", "is_deleted", "0");
    let message_date_deleted = sqlite_optional_column(&chat_db, "message", "date_deleted", "0");
    let message_date_retracted = sqlite_optional_column(&chat_db, "message", "date_retracted", "0");
    let message_is_spam = sqlite_optional_column(&chat_db, "message", "is_spam", "0");
    let chat_is_archived = sqlite_optional_column(&chat_db, "chat", "is_archived", "0");
    let chat_is_blackholed = sqlite_optional_column(&chat_db, "chat", "is_blackholed", "0");
    let chat_is_deleted = sqlite_optional_column(&chat_db, "chat", "is_deleted", "0");
    let chat_date_deleted = sqlite_optional_column(&chat_db, "chat", "date_deleted", "0");
    let attachment_guid = sqlite_optional_column(&chat_db, "attachment", "guid", "''");
    let attachment_filename = sqlite_optional_column(&chat_db, "attachment", "filename", "''");
    let attachment_transfer_name =
        sqlite_optional_column(&chat_db, "attachment", "transfer_name", "''");
    let attachment_uti = sqlite_optional_column(&chat_db, "attachment", "uti", "''");
    let attachment_mime_type = sqlite_optional_column(&chat_db, "attachment", "mime_type", "''");
    let attachment_total_bytes = sqlite_optional_column(&chat_db, "attachment", "total_bytes", "0");
    let start = sqlite_string_literal(&command_window_start(command));
    let end = sqlite_string_literal(&command_window_end(command));
    let message_datetime_sql = "datetime(case when message.date > 1000000000000 then message.date / 1000000000 else message.date end + 978307200, 'unixepoch')";

    let sql = format!(
        r#"
      select
        'imessage' as sourceType,
        message.guid as sourceId,
        message.guid as messageId,
        coalesce(chat.guid, printf('chat:%d', chat.ROWID)) as threadId,
        case
          when message.is_from_me = 1 then coalesce(nullif({destination_caller}, ''), 'me')
          else coalesce(nullif(handle.id, ''), '')
        end as sender,
        coalesce((
          select json_group_array(distinct participant.id)
          from chat_handle_join participant_join
          join handle participant on participant.ROWID = participant_join.handle_id
          where participant_join.chat_id = chat.ROWID
        ), json('[]')) as recipients,
        case
          when chat.display_name is not null and chat.display_name != '' then chat.display_name
          when chat.chat_identifier is not null and chat.chat_identifier != '' then chat.chat_identifier
          when message.is_from_me = 1 then 'Sent iMessage'
          else 'Received iMessage'
        end as title,
        strftime('%Y-%m-%dT%H:%M:%fZ', {message_datetime_sql}) as timestamp,
        coalesce(message.text, '') as content,
        case
          when coalesce(message.text, '') = '' and message.attributedBody is not null then hex(message.attributedBody)
          else ''
        end as attributedBodyHex,
        coalesce((
          select json_group_array(json_object(
            'attachmentId', attachment.ROWID,
            'guid', coalesce({attachment_guid}, ''),
            'filename', coalesce({attachment_filename}, ''),
            'transferName', coalesce({attachment_transfer_name}, ''),
            'uti', coalesce({attachment_uti}, ''),
            'mimeType', coalesce({attachment_mime_type}, ''),
            'totalBytes', coalesce({attachment_total_bytes}, 0)
          ))
          from message_attachment_join attachment_join
          join attachment on attachment.ROWID = attachment_join.attachment_id
          where attachment_join.message_id = message.ROWID
        ), json('[]')) as attachments,
        json_object(
          'rowId', message.ROWID,
          'chatRowId', chat.ROWID,
          'isFromMe', message.is_from_me,
          'service', coalesce(message.service, ''),
          'chatIdentifier', coalesce(chat.chat_identifier, ''),
          'chatGuid', coalesce(chat.guid, ''),
          'messageIsArchive', coalesce({message_is_archive}, 0),
          'messageIsDeleted', coalesce({message_is_deleted}, 0),
          'dateDeleted', coalesce({message_date_deleted}, 0),
          'dateRetracted', coalesce({message_date_retracted}, 0),
          'messageIsSpam', coalesce({message_is_spam}, 0),
          'chatIsArchived', coalesce({chat_is_archived}, 0),
          'chatIsBlackholed', coalesce({chat_is_blackholed}, 0),
          'chatIsDeleted', coalesce({chat_is_deleted}, 0),
          'chatDateDeleted', coalesce({chat_date_deleted}, 0),
          'destinationCallerId', coalesce({destination_caller}, '')
        ) as metadata
      from message
      left join handle on handle.ROWID = message.handle_id
      join chat_message_join on chat_message_join.message_id = message.ROWID
      join chat on chat.ROWID = chat_message_join.chat_id
      where 1 = 1
        {reaction_filter}
        {message_visibility_filter}
        {chat_visibility_filter}
        {recoverable_message_filter}
        and {message_datetime_sql} >= datetime({start})
        and ({end} = '' or {message_datetime_sql} <= datetime({end}))
      order by message.date desc;
    "#
    );

    let mut sqlite = Command::new("sqlite3");
    sqlite.arg("-readonly").arg("-json").arg(chat_db).arg(sql);
    let output = command_output_with_timeout(sqlite, LOCAL_COMMAND_TIMEOUT, "sqlite3")?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let contact_context = read_contact_context();
    parse_records_json(&String::from_utf8_lossy(&output.stdout)).map(|records| {
        enrich_imessage_records_with_contacts(records, &contact_context.contact_names)
            .into_iter()
            .map(|record| {
                normalize_local_user_imessage_record(record, &contact_context.local_handles)
            })
            .filter(|record| !record_matches_excluded_handle(record, &command.excluded_handles))
            .collect()
    })
}

fn command_output_with_timeout(
    mut command: Command,
    timeout_after: Duration,
    label: &str,
) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture {label} stdout."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("failed to capture {label} stderr."))?;
    let stdout_reader = read_child_pipe(stdout, format!("{label} stdout"));
    let stderr_reader = read_child_pipe(stderr, format!("{label} stderr"));
    let started_at = Instant::now();

    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                return Ok(Output {
                    status,
                    stdout: join_child_pipe(stdout_reader)?,
                    stderr: join_child_pipe(stderr_reader)?,
                })
            }
            None if started_at.elapsed() >= timeout_after => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "{label} timed out after {} seconds.",
                    timeout_after.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn read_child_pipe<R>(mut pipe: R, label: String) -> thread::JoinHandle<Result<Vec<u8>, String>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        pipe.read_to_end(&mut output)
            .map_err(|error| format!("failed to read {label}: {error}"))?;
        Ok(output)
    })
}

fn join_child_pipe(reader: thread::JoinHandle<Result<Vec<u8>, String>>) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| "failed to join child output reader.".to_string())?
}

fn sqlite_column_exists(db_path: &PathBuf, table: &str, column: &str) -> bool {
    let query = format!("pragma table_info({table});");
    let mut sqlite = Command::new("sqlite3");
    sqlite.arg("-readonly").arg(db_path).arg(query);
    let Ok(output) = command_output_with_timeout(sqlite, LOCAL_COMMAND_TIMEOUT, "sqlite3") else {
        return false;
    };
    if !output.status.success() {
        return false;
    }

    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        line.split('|')
            .nth(1)
            .is_some_and(|name| name.eq_ignore_ascii_case(column))
    })
}

fn sqlite_table_exists(db_path: &PathBuf, table: &str) -> bool {
    let query = format!(
        "select 1 from sqlite_master where type = 'table' and name = {};",
        sqlite_string_literal(table)
    );
    let mut sqlite = Command::new("sqlite3");
    sqlite.arg("-readonly").arg(db_path).arg(query);
    let Ok(output) = command_output_with_timeout(sqlite, LOCAL_COMMAND_TIMEOUT, "sqlite3") else {
        return false;
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "1"
}

fn sqlite_zero_or_missing_filter(db_path: &PathBuf, table: &str, columns: &[&str]) -> String {
    columns
        .iter()
        .filter(|column| sqlite_column_exists(db_path, table, column))
        .map(|column| format!("and coalesce({table}.{column}, 0) = 0"))
        .collect::<Vec<_>>()
        .join("\n        ")
}

fn sqlite_optional_column(db_path: &PathBuf, table: &str, column: &str, fallback: &str) -> String {
    if sqlite_column_exists(db_path, table, column) {
        format!("{table}.{column}")
    } else {
        fallback.to_string()
    }
}

fn sqlite_optional_column_with_alias(
    db_path: &PathBuf,
    table: &str,
    alias: &str,
    column: &str,
    fallback: &str,
) -> String {
    if sqlite_column_exists(db_path, table, column) {
        format!("{alias}.{column}")
    } else {
        fallback.to_string()
    }
}

fn coalesce_text_columns(
    db_path: &PathBuf,
    table: &str,
    alias: &str,
    columns: &[&str],
    fallback: &str,
) -> String {
    let mut values = columns
        .iter()
        .filter(|column| sqlite_column_exists(db_path, table, column))
        .map(|column| format!("nullif({alias}.{column}, '')"))
        .collect::<Vec<_>>();
    values.push(fallback.to_string());
    format!("coalesce({})", values.join(", "))
}

fn coalesce_number_columns(
    db_path: &PathBuf,
    table: &str,
    alias: &str,
    columns: &[&str],
    fallback: &str,
) -> String {
    let mut values = columns
        .iter()
        .filter(|column| sqlite_column_exists(db_path, table, column))
        .map(|column| format!("{alias}.{column}"))
        .collect::<Vec<_>>();
    values.push(fallback.to_string());
    format!("coalesce({})", values.join(", "))
}

fn sqlite_entity_id(db_path: &PathBuf, entity_name: &str) -> Result<i64, String> {
    let sql = format!(
        "select Z_ENT from Z_PRIMARYKEY where Z_NAME = {} limit 1;",
        sqlite_string_literal(entity_name)
    );
    let mut sqlite = Command::new("sqlite3");
    sqlite.arg("-readonly").arg(db_path).arg(sql);
    let output = command_output_with_timeout(sqlite, LOCAL_COMMAND_TIMEOUT, "sqlite3")?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("Could not resolve Notes entity id for {entity_name}."))
}

fn query_sqlite_json<T: DeserializeOwned>(
    db_path: &PathBuf,
    sql: &str,
    label: &str,
) -> Result<Vec<T>, String> {
    let mut sqlite = Command::new("sqlite3");
    sqlite.arg("-readonly").arg("-json").arg(db_path).arg(sql);
    let output = command_output_with_timeout(sqlite, LOCAL_COMMAND_TIMEOUT, "sqlite3")?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice::<Vec<T>>(&output.stdout)
        .map_err(|error| format!("Could not parse {label} rows: {error}"))
}

fn read_notes_records(command: &BridgeCommand, input: Value) -> Result<Vec<LocalRecord>, String> {
    let query = json_string(&input, "query")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let note_id = json_string(&input, "noteId");
    let include_body = input
        .get("includeBody")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content_limit = input
        .get("contentLimit")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(1200);
    let needs_body = include_body || content_limit > 0 || !query.is_empty();
    let start = command_window_start(command);
    let end = command_window_end(command);

    let rows = with_notes_database_snapshot(|db_path| query_notes_database(db_path, &start, &end))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| normalize_note_row(row, needs_body, include_body, content_limit))
        .filter(|record| note_id.as_ref().map_or(true, |id| record.source_id == *id))
        .filter(|record| record_matches_query(record, &query))
        .collect())
}

fn query_notes_database(
    db_path: &PathBuf,
    start: &str,
    end: &str,
) -> Result<Vec<RawNoteRow>, String> {
    let note_entity_id = sqlite_entity_id(db_path, "ICNote")?;
    let note_identifier = sqlite_optional_column_with_alias(
        db_path,
        "ZICCLOUDSYNCINGOBJECT",
        "note",
        "ZIDENTIFIER",
        "''",
    );
    let note_title = coalesce_text_columns(
        db_path,
        "ZICCLOUDSYNCINGOBJECT",
        "note",
        &["ZTITLE1", "ZTITLE"],
        "'Untitled note'",
    );
    let folder_title = coalesce_text_columns(
        db_path,
        "ZICCLOUDSYNCINGOBJECT",
        "folder",
        &["ZTITLE2", "ZTITLE1", "ZTITLE"],
        "''",
    );
    let modified_date = coalesce_number_columns(
        db_path,
        "ZICCLOUDSYNCINGOBJECT",
        "note",
        &[
            "ZMODIFICATIONDATE1",
            "ZMODIFICATIONDATE",
            "ZCREATIONDATE1",
            "ZCREATIONDATE",
        ],
        "0",
    );
    let note_marked_for_deletion = sqlite_optional_column_with_alias(
        db_path,
        "ZICCLOUDSYNCINGOBJECT",
        "note",
        "ZMARKEDFORDELETION",
        "0",
    );
    let note_password_protected = sqlite_optional_column_with_alias(
        db_path,
        "ZICCLOUDSYNCINGOBJECT",
        "note",
        "ZISPASSWORDPROTECTED",
        "0",
    );
    let folder_type = sqlite_optional_column_with_alias(
        db_path,
        "ZICCLOUDSYNCINGOBJECT",
        "folder",
        "ZFOLDERTYPE",
        "0",
    );
    let start = sqlite_string_literal(start);
    let end = sqlite_string_literal(end);
    let note_datetime_sql =
        format!("datetime(coalesce({modified_date}, 0) + 978307200, 'unixepoch')");

    let sql = format!(
        r#"
      select
        note.Z_PK as rowId,
        coalesce(nullif({note_identifier}, ''), printf('note:%d', note.Z_PK)) as sourceId,
        coalesce(nullif({note_title}, ''), 'Untitled note') as title,
        coalesce({folder_title}, '') as folder,
        strftime('%Y-%m-%dT%H:%M:%fZ', {note_datetime_sql}) as timestamp,
        hex(data.ZDATA) as dataHex
      from ZICCLOUDSYNCINGOBJECT note
      left join ZICCLOUDSYNCINGOBJECT folder on folder.Z_PK = note.ZFOLDER
      left join ZICNOTEDATA data on data.ZNOTE = note.Z_PK
      where note.Z_ENT = {note_entity_id}
        and coalesce({note_marked_for_deletion}, 0) = 0
        and coalesce({note_password_protected}, 0) = 0
        and coalesce({folder_type}, 0) != 1
        and {note_datetime_sql} >= datetime({start})
        and ({end} = '' or {note_datetime_sql} <= datetime({end}))
      order by coalesce({modified_date}, 0) desc;
    "#
    );

    query_sqlite_json(db_path, &sql, "Notes database")
}

fn normalize_note_row(
    row: RawNoteRow,
    decode_body: bool,
    include_body: bool,
    content_limit: usize,
) -> Option<LocalRecord> {
    let source_id = non_empty(row.source_id)?;
    let title = non_empty(row.title).unwrap_or_else(|| "Untitled note".to_string());
    let body = if decode_body {
        row.data_hex
            .as_deref()
            .map(decode_notes_body_hex)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let content = if include_body {
        body
    } else {
        body.chars().take(content_limit).collect()
    };

    Some(LocalRecord {
        source_type: "notes".to_string(),
        source_id,
        message_id: None,
        thread_id: None,
        direction: Some("authored_by_user".to_string()),
        sender: Some("me".to_string()),
        sender_contact: None,
        recipients: Vec::new(),
        recipient_contacts: Vec::new(),
        title,
        timestamp: row.timestamp,
        content,
        attachments: Vec::new(),
        metadata: serde_json::json!({
            "rowId": row.row_id,
            "folder": row.folder,
            "localUser": true,
            "sourceDirection": "authored_by_user",
        }),
    })
}

fn ensure_puter_command_access(command: &BridgeCommand) -> Result<(), String> {
    match command.toolset.as_str() {
        "puter.imessage" => {
            let imessage = check_imessage_access();
            if !imessage.granted {
                return Err(imessage.message);
            }
            let contacts = check_contacts_access();
            if !contacts.granted {
                return Err(contacts.message);
            }
            Ok(())
        }
        "puter.notes" => {
            let notes = check_notes_access();
            if notes.granted {
                Ok(())
            } else {
                Err(notes.message)
            }
        }
        _ => Ok(()),
    }
}

fn execute_puter_command(command: BridgeCommand) -> Result<Value, String> {
    ensure_puter_command_access(&command)?;
    match (command.toolset.as_str(), command.command.as_str()) {
        ("puter.imessage", "chats") => list_imessage_chats(&command),
        ("puter.imessage", "history") => read_imessage_history(&command),
        ("puter.imessage", "search") => search_imessage_messages(&command),
        ("puter.imessage", "load_attachment") => load_imessage_attachment(&command),
        ("puter.imessage", "list_chats") => list_imessage_chats(&command),
        ("puter.imessage", "search_messages") => search_imessage_messages(&command),
        ("puter.imessage", "read_thread") => read_imessage_thread(&command),
        ("puter.notes", "list_notes") => list_notes(&command),
        ("puter.notes", "search_notes") => search_notes(&command),
        ("puter.notes", "get_note") => get_note(&command),
        _ => Err(format!(
            "Unsupported Puter command: {}/{}",
            command.toolset, command.command
        )),
    }
}

async fn run_puter_socket_loop(
    host: String,
    client: Client,
    session_token: String,
    device_id: String,
    app: AppHandle,
    mut socket_outbox: mpsc::UnboundedReceiver<Value>,
) {
    let mut has_connected = false;
    loop {
        match request_puter_socket_url(&host, &client, &session_token, &device_id).await {
            Ok(socket_url) => match run_puter_socket(socket_url, app.clone(), &mut socket_outbox)
                .await
            {
                Ok(connected) => {
                    if connected {
                        has_connected = true;
                        emit_socket_status(&app, false, "Disconnected from Finn. Reconnecting.")
                            .await;
                    } else {
                        emit_socket_status(&app, false, "Could not connect to Finn.").await;
                        return;
                    }
                }
                Err(error) => {
                    eprintln!("Finn Puter socket disconnected: {error}");
                    if !has_connected {
                        emit_socket_status(
                            &app,
                            false,
                            &format!("Could not connect to Finn. {error}"),
                        )
                        .await;
                        return;
                    }
                    emit_socket_status(
                        &app,
                        false,
                        &format!("Disconnected from Finn. Reconnecting. {error}"),
                    )
                    .await;
                }
            },
            Err(error) => {
                eprintln!("Finn Puter socket token failed: {error}");
                if !has_connected {
                    emit_socket_status(&app, false, &format!("Could not connect to Finn. {error}"))
                        .await;
                    return;
                }
                emit_socket_status(&app, false, &format!("Waiting for Finn. {error}")).await;
            }
        }
        sleep(Duration::from_secs(3)).await;
    }
}

async fn request_puter_socket_url(
    host: &str,
    client: &Client,
    session_token: &str,
    device_id: &str,
) -> Result<String, String> {
    let response = client
        .post(format!("{host}/api/web/puter/socket-token"))
        .header(COOKIE, format!("finn_session={session_token}"))
        .json(&serde_json::json!({
            "deviceId": device_id,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let final_origin = http_origin(response.url())?;
    let token: SocketTokenResponse = serde_json::from_value(ensure_success(response).await?)
        .map_err(|error| error.to_string())?;
    puter_socket_url(&final_origin, &token.token)
}

async fn run_puter_socket(
    socket_url: String,
    app: AppHandle,
    socket_outbox: &mut mpsc::UnboundedReceiver<Value>,
) -> Result<bool, String> {
    emit_socket_status(
        &app,
        false,
        &format!("Opening {}.", describe_socket_url(&socket_url)),
    )
    .await;
    let (socket, _) = timeout(Duration::from_secs(10), connect_async(&socket_url))
        .await
        .map_err(|_| format!("Timed out opening {}.", describe_socket_url(&socket_url)))?
        .map_err(|error| {
            format!(
                "Could not open {}: {error}",
                describe_socket_url(&socket_url)
            )
        })?;
    let (mut write, mut read) = socket.split();
    let mut connected = false;
    let mut access_interval = interval(SOCKET_ACCESS_STATUS_INTERVAL);
    let mut heartbeat_interval = interval(SOCKET_HEARTBEAT_INTERVAL);
    let mut config_sync_interval = interval(SOCKET_CONFIG_SYNC_INTERVAL);
    access_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    heartbeat_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    config_sync_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        let message = tokio::select! {
            message = read.next() => message,
            outbound = socket_outbox.recv(), if connected => {
                let Some(outbound) = outbound else {
                    return Ok(true);
                };
                if let Err(error) = write.send(WebSocketMessage::Text(outbound.to_string())).await {
                    return if connected { Ok(true) } else { Err(error.to_string()) };
                }
                continue;
            }
            _ = heartbeat_interval.tick(), if connected => {
                if let Err(error) = write.send(WebSocketMessage::Text(socket_ping_message().to_string())).await {
                    return if connected { Ok(true) } else { Err(error.to_string()) };
                }
                continue;
            }
            _ = config_sync_interval.tick(), if connected => {
                if let Err(error) = write.send(WebSocketMessage::Text(socket_config_request_message().to_string())).await {
                    return if connected { Ok(true) } else { Err(error.to_string()) };
                }
                continue;
            }
            _ = access_interval.tick(), if connected => {
                if let Err(error) = write.send(WebSocketMessage::Text(local_access_status_message().to_string())).await {
                    return if connected { Ok(true) } else { Err(error.to_string()) };
                }
                continue;
            }
        };
        let Some(message) = message else {
            break;
        };
        let message = match message {
            Ok(message) => message,
            Err(_) if connected => return Ok(true),
            Err(error) => return Err(error.to_string()),
        };
        let WebSocketMessage::Text(raw) = message else {
            continue;
        };
        let incoming: SocketIncomingMessage = match serde_json::from_str(&raw) {
            Ok(incoming) => incoming,
            Err(_) if connected => return Ok(true),
            Err(error) => return Err(error.to_string()),
        };
        if incoming.message_type == "ready" {
            connected = true;
            emit_socket_status(&app, true, "Connected to Finn.").await;
            for payload in [
                local_access_status_message(),
                socket_config_request_message(),
            ] {
                if let Err(error) = write
                    .send(WebSocketMessage::Text(payload.to_string()))
                    .await
                {
                    return Err(error.to_string());
                }
            }
            continue;
        }
        if incoming.message_type == "config_update" {
            if let Some(config) = incoming.config {
                dispatch_frontend_event(&app, "puter_config_updated", &config);
            }
            continue;
        }
        if incoming.message_type != "command" {
            continue;
        }
        let Some(command) = incoming.command else {
            continue;
        };

        let command_id = command.id.clone();
        emit_command_activity(&app, Some(command_activity_message(&command)));
        let body = match execute_puter_command(command) {
            Ok(result) => serde_json::json!({
                "type": "result",
                "commandId": command_id,
                "ok": true,
                "result": result,
            }),
            Err(error) => serde_json::json!({
                "type": "result",
                "commandId": command_id,
                "ok": false,
                "error": error,
            }),
        };
        emit_command_activity(&app, None);
        let command_failed = body
            .get("ok")
            .and_then(Value::as_bool)
            .map(|ok| !ok)
            .unwrap_or(false);
        if let Err(error) = write.send(WebSocketMessage::Text(body.to_string())).await {
            if connected {
                return Ok(true);
            }
            return Err(error.to_string());
        }
        if command_failed {
            if let Err(error) = write
                .send(WebSocketMessage::Text(
                    local_access_status_message().to_string(),
                ))
                .await
            {
                if connected {
                    return Ok(true);
                }
                return Err(error.to_string());
            }
        }
    }

    Ok(connected)
}

fn local_access_status_message() -> Value {
    serde_json::json!({
        "type": "access_status",
        "access": {
            "imessage": check_imessage_access(),
            "contacts": check_contacts_access(),
            "notes": check_notes_access(),
        },
    })
}

fn socket_ping_message() -> Value {
    serde_json::json!({
        "type": "ping",
    })
}

fn socket_config_request_message() -> Value {
    serde_json::json!({
        "type": "config_request",
    })
}

async fn send_socket_message(state: &State<'_, PuterState>, message: Value) -> Result<(), String> {
    let sender = state
        .socket_outbox
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Finn Puter is not connected to Finn.".to_string())?;
    sender
        .send(message)
        .map_err(|_| "Finn Puter is reconnecting to Finn.".to_string())
}

fn dispatch_frontend_event<T: Serialize>(app: &AppHandle, event: &str, payload: &T) {
    if let Err(error) = app.emit(event, payload) {
        eprintln!("Failed to emit {event} through Tauri events: {error}");
    }

    dispatch_webview_custom_event(app, event, payload);
}

fn dispatch_webview_custom_event<T: Serialize>(app: &AppHandle, event: &str, payload: &T) {
    let event_json = match serde_json::to_string(event) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Failed to serialize frontend event name {event}: {error}");
            return;
        }
    };
    let payload_json = match serde_json::to_string(payload) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Failed to serialize frontend event payload for {event}: {error}");
            return;
        }
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent({event_json}, {{ detail: {payload_json} }}));"
    );
    for (label, window) in app.webview_windows() {
        if let Err(error) = window.eval(&script) {
            eprintln!("Failed to dispatch {event} into Finn Puter webview {label}: {error}");
        }
    }
}

fn dispatch_command_activity_event(app: &AppHandle, event: CommandActivityEvent) {
    dispatch_frontend_event(app, "puter_command_activity", &event);
    for delay in [Duration::from_millis(120), Duration::from_millis(360)] {
        let app = app.clone();
        let event = event.clone();
        tauri::async_runtime::spawn(async move {
            sleep(delay).await;
            let current_generation = app
                .state::<PuterState>()
                .activity_generation
                .load(Ordering::SeqCst);
            if current_generation == event.generation {
                dispatch_frontend_event(&app, "puter_command_activity", &event);
            }
        });
    }
}

fn emit_command_activity(app: &AppHandle, message: Option<String>) {
    let active = message.is_some();
    let state = app.state::<PuterState>();
    let generation = state.activity_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let message = match message {
        Some(message) => {
            if let Ok(mut last_message) = state.last_activity_message.lock() {
                *last_message = Some(message.clone());
            }
            message
        }
        None => state
            .last_activity_message
            .lock()
            .ok()
            .and_then(|last_message| last_message.clone())
            .unwrap_or_default(),
    };
    if active {
        show_activity_window(app);
    }

    let event = CommandActivityEvent {
        active,
        message,
        generation,
    };
    dispatch_command_activity_event(app, event);

    if !active {
        schedule_activity_window_hide(app, generation);
    }
}

fn command_activity_message(command: &BridgeCommand) -> String {
    let options = match command.toolset.as_str() {
        "puter.imessage" => &[
            "Finn is browsing your iMessages...",
            "Finn is reading through your messages...",
            "Finn is checking an iMessage thread...",
            "Finn is searching your message history...",
        ][..],
        "puter.notes" => &[
            "Finn is pondering your Notes...",
            "Finn is reading through your Notes...",
            "Finn is searching your Notes...",
            "Finn is piecing together your Notes...",
        ][..],
        _ => &[
            "Finn is working on your Mac...",
            "Finn is checking local context...",
            "Finn is gathering local context...",
        ][..],
    };
    let index = stable_phrase_index(&command.id, options.len());
    options[index].to_string()
}

fn stable_phrase_index(value: &str, length: usize) -> usize {
    if length == 0 {
        return 0;
    }
    value.bytes().fold(0_usize, |accumulator, byte| {
        accumulator.wrapping_mul(31).wrapping_add(usize::from(byte))
    }) % length
}

async fn emit_socket_status(app: &AppHandle, connected: bool, message: &str) {
    let event = SocketStatusEvent {
        connected,
        message: message.to_string(),
    };
    *app.state::<PuterState>().socket_status.lock().await = event.clone();
    dispatch_frontend_event(app, "puter_socket_status", &event);
}

fn list_imessage_chats(command: &BridgeCommand) -> Result<Value, String> {
    let limit = json_limit(&command.args, 25, 100);
    let mut chats = serde_json::Map::new();
    for record in read_imessage_records(command)?
        .into_iter()
        .filter(|record| record_in_command_window(record, command))
    {
        let record_sample = record.content.chars().take(240).collect::<String>();
        let thread_id = record
            .thread_id
            .clone()
            .unwrap_or_else(|| record.source_id.clone());
        let chat_id = record
            .metadata
            .get("chatRowId")
            .and_then(Value::as_i64)
            .map(Value::from)
            .unwrap_or(Value::Null);
        let existing = chats.get(&thread_id).cloned().unwrap_or_else(|| {
            serde_json::json!({
                "chatId": chat_id,
                "threadId": thread_id,
                "title": record.title,
                "participants": [],
                "participantDetails": [],
                "lastMessageAt": record.timestamp,
                "messageCount": 0,
                "sample": record_sample.clone(),
            })
        });
        let mut next = existing.as_object().cloned().unwrap_or_default();
        if next
            .get("sample")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
            && !record_sample.trim().is_empty()
        {
            next.insert("sample".to_string(), Value::String(record_sample));
        }
        let mut participants = next
            .get("participants")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(sender) = record.sender.clone() {
            push_unique_string(&mut participants, sender);
        }
        for recipient in record.recipients {
            push_unique_string(&mut participants, recipient);
        }
        let mut participant_details = next
            .get("participantDetails")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(contact) = record.sender_contact {
            push_unique_contact(&mut participant_details, contact);
        }
        for contact in record.recipient_contacts {
            push_unique_contact(&mut participant_details, contact);
        }
        next.insert("participants".to_string(), Value::Array(participants));
        next.insert(
            "participantDetails".to_string(),
            Value::Array(participant_details),
        );
        let count = next
            .get("messageCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        next.insert("messageCount".to_string(), Value::from(count));
        if record.timestamp.as_str()
            > next
                .get("lastMessageAt")
                .and_then(Value::as_str)
                .unwrap_or("")
        {
            next.insert("lastMessageAt".to_string(), Value::String(record.timestamp));
        }
        chats.insert(thread_id, Value::Object(next));
    }

    let mut chats: Vec<Value> = chats.into_values().collect();
    chats.sort_by(|left, right| {
        right
            .get("lastMessageAt")
            .and_then(Value::as_str)
            .cmp(&left.get("lastMessageAt").and_then(Value::as_str))
    });
    let CursorPage {
        items,
        next_cursor,
        previous_cursor,
        total,
    } = paginate_items(chats, &command.args, limit)?;
    Ok(serde_json::json!({
        "windowStart": command.window_start,
        "windowEnd": command.window_end,
        "chats": items,
        "nextCursor": next_cursor,
        "previousCursor": previous_cursor,
        "total": total,
    }))
}

fn search_imessage_messages(command: &BridgeCommand) -> Result<Value, String> {
    let query = json_string(&command.args, "query")
        .unwrap_or_default()
        .to_lowercase();
    let thread_id = json_string(&command.args, "threadId");
    let match_mode = json_string(&command.args, "match").unwrap_or_else(|| "contains".to_string());
    let limit = json_limit(&command.args, 25, 100);
    let mut messages: Vec<LocalRecord> = read_imessage_records(command)?
        .into_iter()
        .filter(|record| record_in_command_window(record, command))
        .filter(|record| {
            thread_id.as_ref().map_or(true, |thread_id| {
                record.thread_id.as_deref() == Some(thread_id.as_str())
            })
        })
        .filter(|record| record_matches_query_with_mode(record, &query, &match_mode))
        .collect();
    messages.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    let CursorPage {
        items,
        next_cursor,
        previous_cursor,
        total,
    } = paginate_items(messages, &command.args, limit)?;
    Ok(serde_json::json!({
        "messages": items,
        "nextCursor": next_cursor,
        "previousCursor": previous_cursor,
        "total": total,
    }))
}

fn read_imessage_thread(command: &BridgeCommand) -> Result<Value, String> {
    let thread_id = json_string(&command.args, "threadId")
        .ok_or_else(|| "threadId is required.".to_string())?;
    let limit = json_limit(&command.args, 50, 200);
    let mut messages: Vec<LocalRecord> = read_imessage_records(command)?
        .into_iter()
        .filter(|record| record_in_command_window(record, command))
        .filter(|record| record.thread_id.as_deref() == Some(thread_id.as_str()))
        .collect();
    messages.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    let CursorPage {
        items,
        next_cursor,
        previous_cursor,
        total,
    } = paginate_newest_window(messages, &command.args, limit)?;
    Ok(serde_json::json!({
        "threadId": thread_id,
        "messages": items,
        "nextCursor": next_cursor,
        "previousCursor": previous_cursor,
        "total": total,
    }))
}

fn read_imessage_history(command: &BridgeCommand) -> Result<Value, String> {
    let chat_id = json_string(&command.args, "chatId");
    let thread_id = json_string(&command.args, "threadId");
    if chat_id.is_none() && thread_id.is_none() {
        return Err("chatId or threadId is required.".to_string());
    }
    let limit = json_limit(&command.args, 50, 200);
    let mut messages: Vec<LocalRecord> = read_imessage_records(command)?
        .into_iter()
        .filter(|record| record_in_command_window(record, command))
        .filter(|record| {
            if let Some(thread_id) = thread_id.as_ref() {
                return record.thread_id.as_deref() == Some(thread_id.as_str());
            }
            chat_id.as_ref().is_some_and(|chat_id| {
                record
                    .metadata
                    .get("chatRowId")
                    .and_then(Value::as_i64)
                    .map(|row_id| row_id.to_string())
                    .as_deref()
                    == Some(chat_id.as_str())
            })
        })
        .collect();
    messages.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    let CursorPage {
        items,
        next_cursor,
        previous_cursor,
        total,
    } = paginate_newest_window(messages, &command.args, limit)?;
    Ok(serde_json::json!({
        "chatId": chat_id,
        "threadId": thread_id,
        "messages": items,
        "nextCursor": next_cursor,
        "previousCursor": previous_cursor,
        "total": total,
    }))
}

fn load_imessage_attachment(command: &BridgeCommand) -> Result<Value, String> {
    let raw_path =
        json_string(&command.args, "path").ok_or_else(|| "path is required.".to_string())?;
    let path = resolve_attachment_path(&raw_path)
        .ok_or_else(|| "Attachment path is invalid.".to_string())?;
    let attachments_root = home_path("Library/Messages/Attachments")?;
    let canonical_root = attachments_root.canonicalize().unwrap_or(attachments_root);
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("Attachment is not readable: {error}"))?;
    if !path_is_within_root(&canonical_path, &canonical_root) {
        return Err("Attachment path is outside Messages attachments.".to_string());
    }

    let metadata = fs::metadata(&canonical_path).map_err(|error| error.to_string())?;
    let max_bytes = command
        .args
        .get("maxBytes")
        .and_then(Value::as_u64)
        .unwrap_or(5_000_000)
        .min(10_000_000);
    if metadata.len() > max_bytes {
        return Err(format!(
            "Attachment is {} bytes, which exceeds the {} byte limit.",
            metadata.len(),
            max_bytes
        ));
    }

    let mut base64 = Command::new("base64");
    base64.arg("-i").arg(&canonical_path);
    let output = command_output_with_timeout(base64, BASE64_COMMAND_TIMEOUT, "base64")?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let data_base64 = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .collect::<String>();

    Ok(serde_json::json!({
        "path": canonical_path.to_string_lossy(),
        "filename": canonical_path.file_name().and_then(|value| value.to_str()).unwrap_or("attachment"),
        "mimeType": mime_type_for_path(&canonical_path),
        "sizeBytes": metadata.len(),
        "dataBase64": data_base64,
    }))
}

fn list_notes(command: &BridgeCommand) -> Result<Value, String> {
    let limit = json_limit(&command.args, 25, 100);
    let mut notes: Vec<LocalRecord> = read_notes_records(
        command,
        serde_json::json!({
            "mode": "list",
            "includeBody": false,
            "contentLimit": 0,
        }),
    )?
    .into_iter()
    .filter(|record| record_in_command_window(record, command))
    .collect();
    notes.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    let CursorPage {
        items,
        next_cursor,
        previous_cursor,
        total,
    } = paginate_items(notes, &command.args, limit)?;
    Ok(serde_json::json!({
        "notes": items.into_iter().map(note_list_item).collect::<Vec<_>>(),
        "nextCursor": next_cursor,
        "previousCursor": previous_cursor,
        "total": total,
    }))
}

fn search_notes(command: &BridgeCommand) -> Result<Value, String> {
    let query = json_string(&command.args, "query")
        .unwrap_or_default()
        .to_lowercase();
    let limit = json_limit(&command.args, 25, 100);
    let mut notes: Vec<LocalRecord> = read_notes_records(
        command,
        serde_json::json!({
            "mode": "search",
            "query": query,
            "includeBody": false,
            "contentLimit": 1200,
        }),
    )?
    .into_iter()
    .filter(|record| record_in_command_window(record, command))
    .collect();
    notes.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    let CursorPage {
        items,
        next_cursor,
        previous_cursor,
        total,
    } = paginate_items(notes, &command.args, limit)?;
    Ok(serde_json::json!({
        "notes": items,
        "nextCursor": next_cursor,
        "previousCursor": previous_cursor,
        "total": total,
    }))
}

fn get_note(command: &BridgeCommand) -> Result<Value, String> {
    let note_id =
        json_string(&command.args, "noteId").ok_or_else(|| "noteId is required.".to_string())?;
    let note = read_notes_records(
        command,
        serde_json::json!({
            "mode": "get",
            "noteId": note_id,
            "includeBody": true,
            "contentLimit": 100_000,
        }),
    )?
    .into_iter()
    .find(|record| record.source_id == note_id && record_in_command_window(record, command));
    Ok(serde_json::json!({ "note": note }))
}

fn note_list_item(record: LocalRecord) -> Value {
    serde_json::json!({
        "sourceType": record.source_type,
        "sourceId": record.source_id,
        "title": record.title,
        "timestamp": record.timestamp,
        "metadata": record.metadata,
    })
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn json_limit(value: &Value, default: usize, max: usize) -> usize {
    value
        .get("limit")
        .and_then(Value::as_u64)
        .map(|limit| limit.max(1).min(max as u64) as usize)
        .unwrap_or(default)
}

fn command_window_start(command: &BridgeCommand) -> String {
    let requested = json_string(&command.args, "start")
        .or_else(|| json_string(&command.args, "since"))
        .or_else(|| json_string(&command.args, "modifiedAfter"));
    max_timestamp(&command.window_start, requested.as_deref())
}

fn command_window_end(command: &BridgeCommand) -> String {
    min_timestamp(
        &command.window_end,
        json_string(&command.args, "end").as_deref(),
    )
}

fn max_timestamp(floor: &str, candidate: Option<&str>) -> String {
    match (parse_rfc3339(floor), candidate.and_then(parse_rfc3339)) {
        (Some(floor_time), Some(candidate_time)) if candidate_time > floor_time => {
            candidate.unwrap_or(floor).to_string()
        }
        _ => floor.to_string(),
    }
}

fn min_timestamp(ceiling: &str, candidate: Option<&str>) -> String {
    match (parse_rfc3339(ceiling), candidate.and_then(parse_rfc3339)) {
        (Some(ceiling_time), Some(candidate_time)) if candidate_time < ceiling_time => {
            candidate.unwrap_or(ceiling).to_string()
        }
        _ => ceiling.to_string(),
    }
}

fn parse_rfc3339(value: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(value).ok()
}

fn sqlite_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

struct CursorPage<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
    previous_cursor: Option<String>,
    total: usize,
}

fn paginate_items<T>(items: Vec<T>, args: &Value, limit: usize) -> Result<CursorPage<T>, String> {
    let offset = json_cursor(args)?;
    let total = items.len();
    let page: Vec<T> = items.into_iter().skip(offset).take(limit).collect();
    let returned = page.len();
    Ok(cursor_page(
        page,
        total,
        offset,
        limit,
        returned,
        offset + returned < total,
    ))
}

fn paginate_newest_window<T>(
    items: Vec<T>,
    args: &Value,
    limit: usize,
) -> Result<CursorPage<T>, String> {
    let offset = json_cursor(args)?;
    let total = items.len();
    let end = total.saturating_sub(offset);
    let start = end.saturating_sub(limit);
    let returned = end.saturating_sub(start);
    let page: Vec<T> = items.into_iter().skip(start).take(returned).collect();
    Ok(cursor_page(page, total, offset, limit, returned, start > 0))
}

fn cursor_page<T>(
    items: Vec<T>,
    total: usize,
    offset: usize,
    limit: usize,
    returned: usize,
    has_more: bool,
) -> CursorPage<T> {
    CursorPage {
        items,
        next_cursor: if has_more {
            Some((offset + returned).to_string())
        } else {
            None
        },
        previous_cursor: if offset > 0 {
            Some(offset.saturating_sub(limit).to_string())
        } else {
            None
        },
        total,
    }
}

fn json_cursor(value: &Value) -> Result<usize, String> {
    match value.get("cursor") {
        None | Some(Value::Null) => Ok(0),
        Some(Value::String(cursor)) => cursor
            .parse::<usize>()
            .map_err(|_| "cursor must be a cursor returned by the previous page.".to_string()),
        Some(Value::Number(cursor)) => cursor
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| "cursor must be a cursor returned by the previous page.".to_string()),
        _ => Err("cursor must be a cursor returned by the previous page.".to_string()),
    }
}

fn record_in_command_window(record: &LocalRecord, command: &BridgeCommand) -> bool {
    let start = command_window_start(command);
    let end = command_window_end(command);
    !record.timestamp.is_empty()
        && record.timestamp.as_str() >= start.as_str()
        && (end.is_empty() || record.timestamp.as_str() <= end.as_str())
}

fn record_matches_query(record: &LocalRecord, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    [
        record.title.as_str(),
        record.content.as_str(),
        record.sender.as_deref().unwrap_or(""),
        record
            .sender_contact
            .as_ref()
            .map(|contact| contact.display_name.as_str())
            .unwrap_or(""),
        record
            .metadata
            .get("folder")
            .and_then(Value::as_str)
            .unwrap_or(""),
        record.thread_id.as_deref().unwrap_or(""),
        record.source_id.as_str(),
    ]
    .into_iter()
    .chain(record.recipients.iter().map(String::as_str))
    .chain(record.attachments.iter().flat_map(|attachment| {
        [
            attachment.filename.as_deref().unwrap_or(""),
            attachment.transfer_name.as_deref().unwrap_or(""),
            attachment.mime_type.as_deref().unwrap_or(""),
            attachment.uti.as_deref().unwrap_or(""),
        ]
    }))
    .chain(
        record
            .recipient_contacts
            .iter()
            .map(|contact| contact.display_name.as_str()),
    )
    .any(|value| value.to_lowercase().contains(query))
}

fn record_matches_query_with_mode(record: &LocalRecord, query: &str, match_mode: &str) -> bool {
    if match_mode == "exact" {
        return record_search_values(record)
            .into_iter()
            .any(|value| value.to_lowercase() == query);
    }

    record_matches_query(record, query)
}

fn record_matches_excluded_handle(record: &LocalRecord, excluded_handles: &[String]) -> bool {
    if excluded_handles.is_empty() {
        return false;
    }
    let excluded: Vec<String> = excluded_handles
        .iter()
        .flat_map(|handle| contact_lookup_keys(handle))
        .collect();
    if excluded.is_empty() {
        return false;
    }

    record_search_handles(record)
        .into_iter()
        .flat_map(|handle| contact_lookup_keys(&handle))
        .any(|key| excluded.contains(&key))
}

fn normalize_local_user_imessage_record(
    mut record: LocalRecord,
    local_handles: &[String],
) -> LocalRecord {
    if record.source_type != "imessage" {
        return record;
    }

    let is_from_me = json_truthy(record.metadata.get("isFromMe"));
    let inferred_from_local_handle =
        !is_from_me && record_sender_matches_handles(&record, local_handles);
    if !is_from_me && !inferred_from_local_handle {
        return record;
    }

    let inferred_sender_handle = inferred_local_sender_handle(&record, inferred_from_local_handle);

    mark_local_user_imessage_metadata(
        &mut record,
        inferred_from_local_handle,
        inferred_sender_handle,
    );

    record.direction = Some("sent_by_user".to_string());
    record.sender = Some("me".to_string());
    record.sender_contact = None;

    record
}

fn inferred_local_sender_handle(
    record: &LocalRecord,
    inferred_from_local_handle: bool,
) -> Option<String> {
    if inferred_from_local_handle {
        return record.sender.clone().and_then(non_empty);
    }
    None
}

fn mark_local_user_imessage_metadata(
    record: &mut LocalRecord,
    inferred_from_local_handle: bool,
    inferred_sender_handle: Option<String>,
) {
    if let Some(metadata) = record.metadata.as_object_mut() {
        metadata.insert("localUser".to_string(), Value::Bool(true));
        metadata.insert(
            "sourceDirection".to_string(),
            Value::String("sent_or_authored_by_user".to_string()),
        );
        metadata.remove("senderDisplayName");
        if let Some(local_sender_handle) = metadata
            .remove("destinationCallerId")
            .and_then(value_to_non_empty_string)
            .or(inferred_sender_handle)
        {
            metadata.insert(
                "localSenderHandle".to_string(),
                Value::String(local_sender_handle),
            );
        }
        if inferred_from_local_handle {
            metadata.insert("isFromMeInferred".to_string(), Value::Bool(true));
        }
    }
}

fn record_sender_matches_handles(record: &LocalRecord, local_handles: &[String]) -> bool {
    let Some(sender) = record.sender.as_deref() else {
        return false;
    };
    if local_handles.is_empty() {
        return false;
    }

    contact_lookup_keys(sender)
        .into_iter()
        .any(|key| local_handles.contains(&key))
}

fn value_to_non_empty_string(value: Value) -> Option<String> {
    match value {
        Value::String(value) => non_empty(value),
        Value::Number(value) => non_empty(value.to_string()),
        _ => None,
    }
}

fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        Some(Value::String(value)) => {
            let normalized = value.trim().to_lowercase();
            !normalized.is_empty()
                && normalized != "0"
                && normalized != "false"
                && normalized != "null"
        }
        _ => false,
    }
}

fn record_search_handles(record: &LocalRecord) -> Vec<String> {
    let mut handles = vec![
        record.sender.clone().unwrap_or_default(),
        record.thread_id.clone().unwrap_or_default(),
        record.title.clone(),
    ];
    handles.extend(record.recipients.iter().cloned());
    handles
}

fn record_search_values(record: &LocalRecord) -> Vec<String> {
    let mut values = vec![
        record.title.clone(),
        record.content.clone(),
        record.sender.clone().unwrap_or_default(),
        record
            .sender_contact
            .as_ref()
            .map(|contact| contact.display_name.clone())
            .unwrap_or_default(),
        record
            .metadata
            .get("folder")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        record.thread_id.clone().unwrap_or_default(),
        record.source_id.clone(),
    ];
    values.extend(record.recipients.iter().cloned());
    values.extend(
        record
            .recipient_contacts
            .iter()
            .map(|contact| contact.display_name.clone()),
    );
    for attachment in &record.attachments {
        values.extend([
            attachment.filename.clone().unwrap_or_default(),
            attachment.transfer_name.clone().unwrap_or_default(),
            attachment.mime_type.clone().unwrap_or_default(),
            attachment.uti.clone().unwrap_or_default(),
        ]);
    }
    values
}

fn push_unique_string(items: &mut Vec<Value>, value: String) {
    if !items
        .iter()
        .any(|item| item.as_str() == Some(value.as_str()))
    {
        items.push(Value::String(value));
    }
}

fn push_unique_contact(items: &mut Vec<Value>, contact: ContactIdentity) {
    if items
        .iter()
        .any(|item| item.get("handle").and_then(Value::as_str) == Some(contact.handle.as_str()))
    {
        return;
    }
    if let Ok(value) = serde_json::to_value(contact) {
        items.push(value);
    }
}

fn parse_records_json(raw: &str) -> Result<Vec<LocalRecord>, String> {
    let records: Vec<RawLocalRecord> =
        serde_json::from_str(raw.trim()).map_err(|error| error.to_string())?;
    Ok(records
        .into_iter()
        .filter_map(normalize_raw_record)
        .collect())
}

fn parse_attachments(value: Option<Value>) -> Vec<AttachmentMetadata> {
    let raw_attachments = match value {
        Some(Value::Array(items)) => {
            serde_json::from_value(Value::Array(items)).unwrap_or_default()
        }
        Some(Value::String(raw)) => {
            serde_json::from_str::<Vec<RawAttachmentMetadata>>(&raw).unwrap_or_default()
        }
        _ => Vec::new(),
    };

    raw_attachments
        .into_iter()
        .map(normalize_attachment_metadata)
        .collect()
}

fn normalize_attachment_metadata(raw: RawAttachmentMetadata) -> AttachmentMetadata {
    let resolved_path = raw.filename.as_deref().and_then(resolve_attachment_path);
    let missing = resolved_path
        .as_ref()
        .map(|path| !path.exists())
        .unwrap_or(true);
    AttachmentMetadata {
        attachment_id: raw.attachment_id,
        guid: raw.guid.and_then(non_empty),
        filename: raw.filename.and_then(non_empty),
        transfer_name: raw.transfer_name.and_then(non_empty),
        uti: raw.uti.and_then(non_empty),
        mime_type: raw.mime_type.and_then(non_empty),
        total_bytes: raw.total_bytes.filter(|bytes| *bytes > 0),
        path: resolved_path.map(|path| path.to_string_lossy().to_string()),
        missing,
    }
}

fn resolve_attachment_path(filename: &str) -> Option<PathBuf> {
    let trimmed = filename.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(relative_home_path) = trimmed.strip_prefix("~/") {
        return home_path(relative_home_path).ok();
    }

    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Some(path);
    }

    home_path(&format!("Library/Messages/{trimmed}")).ok()
}

fn path_is_within_root(path: &PathBuf, root: &PathBuf) -> bool {
    path.starts_with(root)
}

fn mime_type_for_path(path: &PathBuf) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "m4a" => "audio/mp4",
        "caf" => "audio/x-caf",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn enrich_imessage_records_with_contacts(
    records: Vec<LocalRecord>,
    contact_names: &HashMap<String, String>,
) -> Vec<LocalRecord> {
    if contact_names.is_empty() {
        return records;
    }

    records
        .into_iter()
        .map(|mut record| {
            let sender_contact = record
                .sender
                .as_ref()
                .and_then(|handle| contact_identity(handle, contact_names));
            let recipient_contacts: Vec<ContactIdentity> = record
                .recipients
                .iter()
                .filter_map(|handle| contact_identity(handle, contact_names))
                .collect();

            if let Some(title) =
                contact_title_for_record(&record, sender_contact.as_ref(), &recipient_contacts)
            {
                record.title = title;
            }
            record.metadata = metadata_with_contact_names(
                record.metadata,
                sender_contact.as_ref(),
                &recipient_contacts,
            );
            record.sender_contact = sender_contact;
            record.recipient_contacts = recipient_contacts;
            record
        })
        .collect()
}

fn contact_identity(
    handle: &str,
    contact_names: &HashMap<String, String>,
) -> Option<ContactIdentity> {
    let display_name = lookup_contact_name(contact_names, handle)?;
    Some(ContactIdentity {
        handle: handle.to_string(),
        display_name,
    })
}

fn contact_title_for_record(
    record: &LocalRecord,
    sender_contact: Option<&ContactIdentity>,
    recipient_contacts: &[ContactIdentity],
) -> Option<String> {
    let title = record.title.trim();
    if title != "Sent iMessage" && title != "Received iMessage" {
        let title_keys = contact_lookup_keys(title);
        if let Some(contact) = sender_contact.filter(|contact| {
            let contact_keys = contact_lookup_keys(&contact.handle);
            title_keys.iter().any(|key| contact_keys.contains(key))
        }) {
            return Some(contact.display_name.clone());
        }
        if let Some(contact) = recipient_contacts.iter().find(|contact| {
            let contact_keys = contact_lookup_keys(&contact.handle);
            title_keys.iter().any(|key| contact_keys.contains(key))
        }) {
            return Some(contact.display_name.clone());
        }
        return None;
    }

    let preferred_contact =
        if json_truthy(record.metadata.get("isFromMe")) || record.sender.as_deref() == Some("me") {
            recipient_contacts.first().or(sender_contact)
        } else {
            sender_contact.or_else(|| recipient_contacts.first())
        };

    preferred_contact.map(|contact| contact.display_name.clone())
}

fn metadata_with_contact_names(
    metadata: Value,
    sender_contact: Option<&ContactIdentity>,
    recipient_contacts: &[ContactIdentity],
) -> Value {
    let mut metadata = metadata.as_object().cloned().unwrap_or_default();
    if let Some(contact) = sender_contact {
        metadata.insert(
            "senderDisplayName".to_string(),
            Value::String(contact.display_name.clone()),
        );
    }
    if !recipient_contacts.is_empty() {
        let recipient_names = recipient_contacts
            .iter()
            .map(|contact| Value::String(contact.display_name.clone()))
            .collect();
        metadata.insert(
            "recipientDisplayNames".to_string(),
            Value::Array(recipient_names),
        );
    }
    Value::Object(metadata)
}

#[cfg(target_os = "macos")]
fn read_contact_context() -> ContactContext {
    native_contact_context().unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn read_contact_context() -> ContactContext {
    ContactContext::default()
}

#[cfg(target_os = "macos")]
fn native_contact_context() -> Result<ContactContext, String> {
    if !contacts_access_granted(contacts_authorization_status()) {
        return Ok(ContactContext::default());
    }

    let store = unsafe { CNContactStore::new() };
    let keys = contact_keys_to_fetch();
    let request = unsafe {
        CNContactFetchRequest::initWithKeysToFetch(CNContactFetchRequest::alloc(), &keys)
    };
    let contact_names = Arc::new(StdMutex::new(HashMap::new()));
    let mut error: Option<Retained<NSError>> = None;
    let contact_names_for_block = Arc::clone(&contact_names);
    let block = RcBlock::new(
        move |contact_ptr: std::ptr::NonNull<CNContact>, _stop: std::ptr::NonNull<Bool>| {
            let contact = unsafe { contact_ptr.as_ref() };
            let name = contact_display_name(contact);
            if name.is_empty() {
                return;
            }
            for handle in contact_handles(contact) {
                let Ok(mut names) = contact_names_for_block.lock() else {
                    return;
                };
                insert_contact_aliases(&mut names, &handle, &name);
            }
        },
    );

    let ok = unsafe {
        store.enumerateContactsWithFetchRequest_error_usingBlock(&request, Some(&mut error), &block)
    };
    if !ok {
        return Err(error
            .map(|value| value.to_string())
            .unwrap_or_else(|| "Could not read Contacts.".to_string()));
    }
    drop(block);

    let mut local_handles = unsafe { store.unifiedMeContactWithKeysToFetch_error(&keys) }
        .ok()
        .map(|contact| {
            contact_handles(&contact)
                .into_iter()
                .flat_map(|handle| contact_lookup_keys(&handle))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    local_handles.sort();
    local_handles.dedup();

    Ok(ContactContext {
        contact_names: shared_contact_names_to_map(contact_names),
        local_handles,
    })
}

fn shared_contact_names_to_map(
    contact_names: Arc<StdMutex<HashMap<String, String>>>,
) -> HashMap<String, String> {
    match Arc::try_unwrap(contact_names) {
        Ok(names) => names.into_inner().unwrap_or_default(),
        Err(names) => names.lock().map(|names| names.clone()).unwrap_or_default(),
    }
}

#[cfg(target_os = "macos")]
fn contact_keys_to_fetch() -> Retained<NSArray<ProtocolObject<dyn CNKeyDescriptor>>> {
    let keys: [Retained<ProtocolObject<dyn CNKeyDescriptor>>; 6] = unsafe {
        [
            ProtocolObject::from_retained(CNContactGivenNameKey.retain()),
            ProtocolObject::from_retained(CNContactMiddleNameKey.retain()),
            ProtocolObject::from_retained(CNContactFamilyNameKey.retain()),
            ProtocolObject::from_retained(CNContactNicknameKey.retain()),
            ProtocolObject::from_retained(CNContactOrganizationNameKey.retain()),
            ProtocolObject::from_retained(CNContactPhoneNumbersKey.retain()),
        ]
    };
    let mut keys = keys.to_vec();
    keys.push(unsafe { ProtocolObject::from_retained(CNContactEmailAddressesKey.retain()) });
    NSArray::from_retained_slice(&keys)
}

#[cfg(target_os = "macos")]
fn contact_display_name(contact: &CNContact) -> String {
    let full_name = [
        unsafe { contact.givenName() }.to_string(),
        unsafe { contact.middleName() }.to_string(),
        unsafe { contact.familyName() }.to_string(),
    ]
    .into_iter()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    if !full_name.is_empty() {
        return full_name;
    }

    [
        unsafe { contact.organizationName() }.to_string(),
        unsafe { contact.nickname() }.to_string(),
    ]
    .into_iter()
    .map(|value| value.trim().to_string())
    .find(|value| !value.is_empty())
    .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn contact_handles(contact: &CNContact) -> Vec<String> {
    let mut handles = Vec::new();
    for email in unsafe { contact.emailAddresses() }.iter() {
        let value = unsafe { email.value() }.to_string();
        if !value.trim().is_empty() {
            handles.push(value);
        }
    }
    for phone in unsafe { contact.phoneNumbers() }.iter() {
        let value = unsafe { phone.value().stringValue() }.to_string();
        if !value.trim().is_empty() {
            handles.push(value);
        }
    }
    handles
}

fn insert_contact_aliases(contact_names: &mut HashMap<String, String>, handle: &str, name: &str) {
    for key in contact_lookup_keys(handle) {
        contact_names.entry(key).or_insert_with(|| name.to_string());
    }
}

fn lookup_contact_name(contact_names: &HashMap<String, String>, handle: &str) -> Option<String> {
    contact_lookup_keys(handle)
        .into_iter()
        .find_map(|key| contact_names.get(&key).cloned())
}

fn contact_lookup_keys(handle: &str) -> Vec<String> {
    let normalized = handle.trim().to_lowercase();
    let digits: String = normalized
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect();
    let mut keys = Vec::new();
    if !normalized.is_empty() {
        keys.push(normalized);
    }
    if !digits.is_empty() {
        keys.push(digits.clone());
        if digits.len() > 10 {
            keys.push(digits[digits.len() - 10..].to_string());
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

fn normalize_raw_record(record: RawLocalRecord) -> Option<LocalRecord> {
    let source_id = non_empty(record.source_id)?;
    let text_content = record.content.unwrap_or_default().trim().to_string();
    let content = if text_content.is_empty() {
        record
            .attributed_body_hex
            .as_deref()
            .and_then(decode_imessage_attributed_body_hex)
            .unwrap_or_default()
    } else {
        text_content
    };
    let attachments = parse_attachments(record.attachments);
    if record.source_type != "notes" && content.is_empty() && attachments.is_empty() {
        return None;
    }
    Some(LocalRecord {
        source_type: record.source_type,
        source_id,
        message_id: record.message_id.and_then(non_empty),
        thread_id: record.thread_id.and_then(non_empty),
        direction: None,
        sender: record.sender.and_then(non_empty),
        sender_contact: None,
        recipients: parse_recipients(record.recipients),
        recipient_contacts: Vec::new(),
        title: record.title.unwrap_or_default(),
        timestamp: record.timestamp.unwrap_or_default(),
        content,
        attachments,
        metadata: parse_metadata(record.metadata),
    })
}

fn parse_metadata(value: Option<Value>) -> Value {
    match value {
        Some(Value::String(raw)) if raw.trim().is_empty() => serde_json::json!({}),
        Some(Value::String(raw)) => {
            serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| serde_json::json!({}))
        }
        Some(value) => value,
        None => serde_json::json!({}),
    }
}

fn decode_imessage_attributed_body_hex(hex: &str) -> Option<String> {
    let bytes = decode_hex(hex)?;
    extract_typedstream_nsstring(&bytes).or_else(|| extract_lossy_typedstream_text(&bytes))
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    let compact: Vec<u8> = hex
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if compact.is_empty() || compact.len() % 2 != 0 {
        return None;
    }

    let mut bytes = Vec::with_capacity(compact.len() / 2);
    for pair in compact.chunks_exact(2) {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        bytes.push((high << 4) | low);
    }
    Some(bytes)
}

fn decode_notes_body_hex(hex: &str) -> String {
    let Some(compressed) = decode_hex(hex) else {
        return String::new();
    };
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut bytes = Vec::new();
    if decoder.read_to_end(&mut bytes).is_err() {
        return String::new();
    }

    extract_notes_note_text(&bytes).unwrap_or_default()
}

fn extract_notes_note_text(bytes: &[u8]) -> Option<String> {
    for document in protobuf_length_delimited_fields(bytes, 2) {
        for note in protobuf_length_delimited_fields(&document, 3) {
            if let Some(text) = protobuf_first_string_field(&note, 2) {
                return Some(normalize_notes_text(&text));
            }
        }
    }
    for note in protobuf_length_delimited_fields(bytes, 3) {
        if let Some(text) = protobuf_first_string_field(&note, 2) {
            return Some(normalize_notes_text(&text));
        }
    }
    protobuf_first_string_field(bytes, 2).map(|text| normalize_notes_text(&text))
}

fn protobuf_length_delimited_fields(bytes: &[u8], target_field: u64) -> Vec<Vec<u8>> {
    let mut fields = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let Some(tag) = read_protobuf_varint(bytes, &mut index) else {
            break;
        };
        let field_number = tag >> 3;
        let wire_type = tag & 0b111;
        match wire_type {
            0 => {
                if read_protobuf_varint(bytes, &mut index).is_none() {
                    break;
                }
            }
            1 => index = index.saturating_add(8),
            2 => {
                let Some(length) = read_protobuf_varint(bytes, &mut index)
                    .and_then(|value| usize::try_from(value).ok())
                else {
                    break;
                };
                let end = index.saturating_add(length);
                if end > bytes.len() {
                    break;
                }
                if field_number == target_field {
                    fields.push(bytes[index..end].to_vec());
                }
                index = end;
            }
            5 => index = index.saturating_add(4),
            _ => break,
        }
    }
    fields
}

fn protobuf_first_string_field(bytes: &[u8], target_field: u64) -> Option<String> {
    protobuf_length_delimited_fields(bytes, target_field)
        .into_iter()
        .find_map(|value| String::from_utf8(value).ok())
}

fn read_protobuf_varint(bytes: &[u8], index: &mut usize) -> Option<u64> {
    let mut result = 0_u64;
    let mut shift = 0_u32;
    while *index < bytes.len() && shift < 64 {
        let byte = bytes[*index];
        *index += 1;
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
    }
    None
}

fn normalize_notes_text(text: &str) -> String {
    text.replace('\u{fffc}', " ")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn extract_typedstream_nsstring(bytes: &[u8]) -> Option<String> {
    const MARKER: &[u8] = b"NSString";
    const PREAMBLE: &[u8] = &[0x01, 0x94, 0x84, 0x01, 0x2b];

    for marker_index in find_subsequence_indices(bytes, MARKER) {
        let marker_end = marker_index + MARKER.len();
        let search_end = (marker_end + 16).min(bytes.len());
        for cursor in marker_end..search_end {
            if !bytes[cursor..].starts_with(PREAMBLE) {
                continue;
            }
            let length_index = cursor + PREAMBLE.len();
            for (content_index, content_length) in typedstream_string_lengths(bytes, length_index) {
                let content_end = content_index.checked_add(content_length)?;
                if content_end > bytes.len() {
                    continue;
                }
                if let Some(text) =
                    normalize_decoded_message_text(&bytes[content_index..content_end])
                {
                    return Some(text);
                }
            }
        }
    }

    None
}

fn typedstream_string_lengths(bytes: &[u8], length_index: usize) -> Vec<(usize, usize)> {
    let Some(first) = bytes.get(length_index).copied() else {
        return Vec::new();
    };

    if first == 0x81 {
        let mut lengths = Vec::new();
        if let Some(length) = bytes.get(length_index + 1).copied() {
            lengths.push((length_index + 2, usize::from(length)));
        }
        if length_index + 2 < bytes.len() {
            lengths.push((
                length_index + 3,
                usize::from(u16::from_be_bytes([
                    bytes[length_index + 1],
                    bytes[length_index + 2],
                ])),
            ));
        }
        return lengths;
    }

    vec![(length_index + 1, usize::from(first))]
}

fn find_subsequence_indices(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return Vec::new();
    }

    haystack
        .windows(needle.len())
        .enumerate()
        .filter_map(|(index, window)| (window == needle).then_some(index))
        .collect()
}

fn normalize_decoded_message_text(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    if text.is_empty() || text.starts_with("NS") {
        return None;
    }
    let printable_count = text
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .count();
    if printable_count == 0 {
        return None;
    }

    Some(text.to_string())
}

fn extract_lossy_typedstream_text(bytes: &[u8]) -> Option<String> {
    let decoded = String::from_utf8_lossy(bytes);
    let after_nsstring = decoded.split("NSString").nth(1)?;
    let before_attributes = after_nsstring
        .split("NSDictionary")
        .next()
        .unwrap_or(after_nsstring)
        .split("NSNumber")
        .next()
        .unwrap_or(after_nsstring);
    let cleaned = before_attributes
        .chars()
        .filter(|character| {
            !character.is_control() && *character != '\u{fffd}'
                || matches!(character, '\n' | '\r' | '\t')
        })
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() || cleaned.starts_with("NS") {
        None
    } else {
        Some(cleaned)
    }
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_recipients(value: Option<Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .filter(|item| !item.trim().is_empty())
            .collect(),
        Some(Value::String(raw)) => serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn check_imessage_access() -> PermissionCheck {
    let Ok(chat_db) = home_path("Library/Messages/chat.db") else {
        return PermissionCheck {
            granted: false,
            message: "Could not find your home folder.".to_string(),
        };
    };
    if !chat_db.exists() {
        return PermissionCheck {
            granted: false,
            message: "Messages is not set up on this Mac yet.".to_string(),
        };
    }

    if let Err(error) = fs::File::open(&chat_db) {
        if error.kind() == ErrorKind::PermissionDenied {
            log_imessage_access_error(&chat_db, &error.to_string());
            return PermissionCheck {
                granted: false,
                message: imessage_full_disk_access_message(&chat_db),
            };
        }
        return PermissionCheck {
            granted: false,
            message: format!("Could not open {}: {error}", chat_db.display()),
        };
    }

    let mut sqlite = Command::new("sqlite3");
    sqlite
        .arg("-readonly")
        .arg(&chat_db)
        .arg("select count(*) from message limit 1;");
    match command_output_with_timeout(sqlite, LOCAL_COMMAND_TIMEOUT, "sqlite3") {
        Ok(output) if output.status.success() => PermissionCheck {
            granted: true,
            message: "iMessage access is ready.".to_string(),
        },
        Ok(output) => {
            let raw_error = String::from_utf8_lossy(&output.stderr);
            if is_imessage_permission_error(&raw_error) {
                log_imessage_access_error(&chat_db, &raw_error);
                return PermissionCheck {
                    granted: false,
                    message: imessage_full_disk_access_message(&chat_db),
                };
            }
            PermissionCheck {
                granted: false,
                message: format_permission_message(&raw_error),
            }
        }
        Err(error) => PermissionCheck {
            granted: false,
            message: error.to_string(),
        },
    }
}

fn is_imessage_permission_error(raw: &str) -> bool {
    is_full_disk_access_error(raw)
}

fn is_full_disk_access_error(raw: &str) -> bool {
    let normalized = raw.to_lowercase();
    normalized.contains("operation not permitted")
        || normalized.contains("permission denied")
        || normalized.contains("not authorized")
        || normalized.contains("authorization")
        || normalized.contains("unable to open database file")
}

fn imessage_full_disk_access_message(_chat_db: &PathBuf) -> String {
    "Finn Puter needs Full Disk Access. Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access, enable Finn Puter, then return and check again."
        .to_string()
}

fn log_imessage_access_error(chat_db: &PathBuf, raw_error: &str) {
    eprintln!(
        "Finn Puter Messages database access check failed for {}: {}",
        chat_db.display(),
        raw_error.trim()
    );
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

fn check_accessibility_access() -> PermissionCheck {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: AXIsProcessTrusted is a no-argument ApplicationServices call
        // returning macOS Boolean (unsigned char) with no ownership transfer.
        let granted = unsafe { AXIsProcessTrusted() != 0 };
        return PermissionCheck {
            granted,
            message: if granted {
                "Accessibility access is ready.".to_string()
            } else {
                "Accessibility access is optional unless Finn Puter needs to control another app window.".to_string()
            },
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        PermissionCheck {
            granted: false,
            message: "Accessibility access is only available on macOS.".to_string(),
        }
    }
}

fn check_contacts_access() -> PermissionCheck {
    #[cfg(target_os = "macos")]
    {
        return match contacts_authorization_status() {
            status if contacts_access_granted(status) => PermissionCheck {
                granted: true,
                message: "Contacts access is ready.".to_string(),
            },
            CNAuthorizationStatus::NotDetermined => PermissionCheck {
                granted: false,
                message: "Contacts access has not been requested yet.".to_string(),
            },
            CNAuthorizationStatus::Denied => PermissionCheck {
                granted: false,
                message: "Contacts access is denied in macOS Settings.".to_string(),
            },
            CNAuthorizationStatus::Limited => PermissionCheck {
                granted: false,
                message:
                    "Contacts access is limited. Allow full Contacts access in macOS Settings."
                        .to_string(),
            },
            CNAuthorizationStatus::Restricted => PermissionCheck {
                granted: false,
                message: "Contacts access is restricted on this Mac.".to_string(),
            },
            _ => PermissionCheck {
                granted: false,
                message: "Contacts access is not available yet.".to_string(),
            },
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        PermissionCheck {
            granted: false,
            message: "Contacts access is only available on macOS.".to_string(),
        }
    }
}

async fn request_contacts_access() -> PermissionCheck {
    #[cfg(target_os = "macos")]
    {
        let status = contacts_authorization_status();
        if contacts_access_granted(status) || status != CNAuthorizationStatus::NotDetermined {
            return check_contacts_access();
        }

        let (sender, receiver) = oneshot::channel();
        thread::spawn(move || {
            let _ = sender.send(wait_for_contacts_access_request());
        });
        match timeout(Duration::from_secs(125), receiver).await {
            Ok(Ok(result)) => result,
            Err(_) => PermissionCheck {
                granted: false,
                message: "Contacts permission request timed out.".to_string(),
            },
            Ok(Err(_)) => PermissionCheck {
                granted: false,
                message: "Contacts permission request was cancelled.".to_string(),
            },
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        check_contacts_access()
    }
}

#[cfg(target_os = "macos")]
fn wait_for_contacts_access_request() -> PermissionCheck {
    let store = unsafe { CNContactStore::new() };
    let (sender, receiver) = std::sync::mpsc::channel();
    let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = sender.send(granted.as_bool());
    });
    unsafe {
        store.requestAccessForEntityType_completionHandler(CNEntityType::Contacts, &block);
    }

    match receiver.recv_timeout(Duration::from_secs(120)) {
        Ok(true) => PermissionCheck {
            granted: true,
            message: "Contacts access is ready.".to_string(),
        },
        Ok(false) => check_contacts_access(),
        Err(_) => PermissionCheck {
            granted: false,
            message: "Contacts permission request timed out.".to_string(),
        },
    }
}

#[cfg(target_os = "macos")]
fn contacts_authorization_status() -> CNAuthorizationStatus {
    unsafe { CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts) }
}

#[cfg(target_os = "macos")]
fn contacts_access_granted(status: CNAuthorizationStatus) -> bool {
    matches!(status, CNAuthorizationStatus::Authorized)
}

fn check_notes_access() -> PermissionCheck {
    let Ok(notes_db) = notes_database_path() else {
        return PermissionCheck {
            granted: false,
            message: "Could not find your home folder.".to_string(),
        };
    };
    if !notes_db.exists() {
        return PermissionCheck {
            granted: false,
            message: "Notes is not set up on this Mac yet.".to_string(),
        };
    }

    match with_notes_database_snapshot(|db_path| {
        let note_entity_id = sqlite_entity_id(db_path, "ICNote")?;
        let sql = format!(
            "select count(*) from ZICCLOUDSYNCINGOBJECT where Z_ENT = {note_entity_id} limit 1;"
        );
        let mut sqlite = Command::new("sqlite3");
        sqlite.arg("-readonly").arg(db_path).arg(sql);
        let output = command_output_with_timeout(sqlite, LOCAL_COMMAND_TIMEOUT, "sqlite3")?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }) {
        Ok(()) => PermissionCheck {
            granted: true,
            message: "Notes access is ready.".to_string(),
        },
        Err(error) => {
            if is_full_disk_access_error(&error) {
                log_notes_access_error(&notes_db, &error);
                return PermissionCheck {
                    granted: false,
                    message: notes_full_disk_access_message(&notes_db),
                };
            }
            PermissionCheck {
                granted: false,
                message: format_permission_message(&error),
            }
        }
    }
}

fn notes_database_path() -> Result<PathBuf, String> {
    home_path("Library/Group Containers/group.com.apple.notes/NoteStore.sqlite")
}

fn with_notes_database_snapshot<T>(
    read_snapshot: impl FnOnce(&PathBuf) -> Result<T, String>,
) -> Result<T, String> {
    let source = notes_database_path()?;
    if !source.exists() {
        return Err(format!(
            "Notes database was not found at {}.",
            source.display()
        ));
    }

    let temp_dir = std::env::temp_dir().join(format!("finn-puter-notes-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let snapshot = temp_dir.join("NoteStore.sqlite");
    let result =
        copy_notes_database_files(&source, &snapshot).and_then(|()| read_snapshot(&snapshot));
    let _ = fs::remove_dir_all(&temp_dir);
    result
}

fn copy_notes_database_files(source: &Path, snapshot: &Path) -> Result<(), String> {
    fs::copy(source, snapshot)
        .map(|_| ())
        .map_err(|error| notes_copy_error(source, error))?;
    copy_optional_sqlite_companion(source, snapshot, "-wal")?;
    copy_optional_sqlite_companion(source, snapshot, "-shm")?;
    Ok(())
}

fn copy_optional_sqlite_companion(
    source: &Path,
    snapshot: &Path,
    suffix: &str,
) -> Result<(), String> {
    let source_path = PathBuf::from(format!("{}{}", source.display(), suffix));
    if !source_path.exists() {
        return Ok(());
    }

    let snapshot_path = PathBuf::from(format!("{}{}", snapshot.display(), suffix));
    fs::copy(&source_path, &snapshot_path)
        .map(|_| ())
        .map_err(|error| notes_copy_error(&source_path, error))
}

fn notes_copy_error(path: &Path, error: std::io::Error) -> String {
    if error.kind() == ErrorKind::PermissionDenied {
        return "Permission denied while reading Notes. Grant Full Disk Access in System Settings."
            .to_string();
    }
    format!(
        "Could not read Notes database file {}: {error}",
        path.display()
    )
}

fn notes_full_disk_access_message(_notes_db: &PathBuf) -> String {
    "Finn Puter needs Full Disk Access. Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access, enable Finn Puter, then return and check again."
        .to_string()
}

fn log_notes_access_error(notes_db: &PathBuf, raw_error: &str) {
    eprintln!(
        "Finn Puter Notes database access check failed for {}: {}",
        notes_db.display(),
        raw_error.trim()
    );
}

fn format_permission_message(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "Access is not available yet.".to_string()
    } else if trimmed.to_lowercase().contains("authorization")
        || trimmed.to_lowercase().contains("operation not permitted")
    {
        "macOS is waiting for permission.".to_string()
    } else {
        trimmed.to_string()
    }
}

fn home_path(relative: &str) -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(relative))
        .map_err(|_| "Could not resolve HOME.".to_string())
}

async fn with_session_cookie(
    _state: &State<'_, PuterState>,
    request: RequestBuilder,
) -> RequestBuilder {
    match load_session_token() {
        Some(token) => request.header(COOKIE, format!("finn_session={token}")),
        None => request,
    }
}

async fn require_session_token(state: &State<'_, PuterState>) -> Result<String, String> {
    let _ = state;
    load_session_token().ok_or_else(|| "Sign in to Finn first.".to_string())
}

async fn persist_session_cookie(
    state: &State<'_, PuterState>,
    response: &reqwest::Response,
) -> Result<(), String> {
    let Some(token) = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(extract_finn_session_cookie)
    else {
        return Ok(());
    };

    let _ = state;
    store_session_token(&token)
}

fn extract_finn_session_cookie(raw: &str) -> Option<String> {
    raw.strip_prefix("finn_session=")
        .and_then(|rest| rest.split(';').next())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn load_session_token() -> Option<String> {
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_SESSION_ACCOUNT) {
        Ok(bytes) => String::from_utf8(bytes)
            .ok()
            .filter(|value| !value.trim().is_empty()),
        Err(_) => None,
    }
}

fn store_session_token(token: &str) -> Result<(), String> {
    set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_SESSION_ACCOUNT, token.as_bytes())
        .map_err(|error| format!("Could not save Finn session in Keychain: {error}"))
}

fn delete_session_token() -> Result<(), String> {
    match delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_SESSION_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(error) => Err(format!(
            "Could not remove Finn session from Keychain: {error}"
        )),
    }
}

async fn require_host(state: &State<'_, PuterState>) -> Result<String, String> {
    let host = state
        .config
        .lock()
        .await
        .host
        .clone()
        .ok_or_else(|| "Choose a Finn instance first.".to_string())?;
    normalize_host(&host)
}

fn puter_socket_url(host: &str, token: &str) -> Result<String, String> {
    let host = host.trim_end_matches('/');
    let base = if let Some(rest) = host.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = host.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err("Finn host must start with http:// or https://.".to_string());
    };
    Ok(format!("{base}/api/web/puter/socket?token={token}"))
}

fn describe_socket_url(socket_url: &str) -> String {
    reqwest::Url::parse(socket_url)
        .ok()
        .and_then(|url| {
            let scheme = url.scheme().to_string();
            let host = url.host_str()?.to_string();
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            Some(format!("{scheme}://{host}{port}"))
        })
        .unwrap_or_else(|| "Puter WebSocket".to_string())
}

fn normalize_host(host: &str) -> Result<String, String> {
    let trimmed = host.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Enter a Finn host.".to_string());
    }
    let lower_trimmed = trimmed.to_ascii_lowercase();
    if lower_trimmed.starts_with("http://") || lower_trimmed.starts_with("https://") {
        return normalize_explicit_http_host(trimmed);
    }
    if should_default_to_http(trimmed) {
        return Ok(add_scheme_to_host("http", trimmed));
    }
    Ok(add_scheme_to_host("https", trimmed))
}

fn apply_configured_host(
    config: &mut StoredPuterConfig,
    normalized_host: String,
) -> Result<(), String> {
    apply_configured_host_with(config, normalized_host, delete_session_token)
}

fn apply_configured_host_with<F>(
    config: &mut StoredPuterConfig,
    normalized_host: String,
    clear_session: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    if config.host.as_deref() != Some(normalized_host.as_str()) {
        clear_session()?;
        config.setup_completed = false;
    }
    config.host = Some(normalized_host);
    Ok(())
}

fn http_origin(url: &reqwest::Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Finn host is missing a hostname.".to_string())?;
    let port = url
        .port()
        .map(|value| format!(":{value}"))
        .unwrap_or_default();
    let scheme = match url.scheme() {
        "https" => "https",
        "http" if should_preserve_explicit_http(host) => "http",
        "http" => "https",
        _ => return Err("Finn host must use http:// or https://.".to_string()),
    };
    Ok(format!("{scheme}://{}{}", format_url_host(host), port))
}

fn normalize_explicit_http_host(host: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(host)
        .map_err(|_| "Finn host must be a valid http:// or https:// URL.".to_string())?;
    http_origin(&url)
}

fn should_default_to_http(host: &str) -> bool {
    is_loopback_host(host)
}

fn is_loopback_host(host: &str) -> bool {
    let host = host_without_port(host);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| match ip {
            IpAddr::V4(address) => address.is_loopback(),
            IpAddr::V6(address) => address.is_loopback(),
        })
        .unwrap_or(false)
}

fn should_preserve_explicit_http(host: &str) -> bool {
    let host = host_without_port(host);
    if is_loopback_host(host) {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(address) => {
                address.is_private() || address.is_link_local() || is_shared_tailscale_ipv4(address)
            }
            IpAddr::V6(address) => is_unique_local_ipv6(address) || is_link_local_ipv6(address),
        };
    }
    let host = host.to_ascii_lowercase();
    host.ends_with(".local")
        || host.ends_with(".ts.net")
        || (!host.contains('.') && !host.contains(':'))
}

fn host_without_port(host: &str) -> &str {
    let host = host.split('/').next().unwrap_or(host).trim();
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split_once(']').map(|(value, _)| value).unwrap_or(rest);
    }
    if host.matches(':').count() == 1 {
        return host
            .rsplit_once(':')
            .map(|(value, _)| value)
            .unwrap_or(host);
    }
    host
}

fn add_scheme_to_host(scheme: &str, host: &str) -> String {
    if !host.starts_with('[') && host.parse::<Ipv6Addr>().is_ok() {
        return format!("{scheme}://[{host}]");
    }
    format!("{scheme}://{host}")
}

fn format_url_host(host: &str) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        return format!("[{host}]");
    }
    host.to_string()
}

fn is_shared_tailscale_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_unique_local_ipv6(address: Ipv6Addr) -> bool {
    (address.segments()[0] & 0xfe00) == 0xfc00
}

fn is_link_local_ipv6(address: Ipv6Addr) -> bool {
    (address.segments()[0] & 0xffc0) == 0xfe80
}

async fn ensure_success(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or(text);
        return Err(message);
    }
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn load_stored_config() -> StoredPuterConfig {
    let Ok(path) = stored_config_path() else {
        return StoredPuterConfig::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return StoredPuterConfig::default();
    };
    let legacy: LegacyStoredPuterConfig = serde_json::from_str(&raw).unwrap_or_default();
    let config = StoredPuterConfig {
        host: legacy.host,
        device_id: legacy.device_id,
        setup_completed: legacy.setup_completed.unwrap_or(false),
    };
    if legacy.session_token.is_some() {
        let _ = write_stored_config(&path, &config);
    }
    config
}

fn save_stored_config(config: &StoredPuterConfig) -> Result<(), String> {
    let path = stored_config_path()?;
    write_stored_config(&path, config)
}

fn write_stored_config(path: &PathBuf, config: &StoredPuterConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn stored_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "Could not resolve HOME.".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Finn Puter")
        .join("config.json"))
}

fn create_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let open = MenuItem::with_id(app, "open", "Open Puter", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Puter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    TrayIconBuilder::with_id("finn-puter")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Finn Puter")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn ensure_activity_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        ACTIVITY_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=activity".into()),
    )
    .title("Finn activity")
    .inner_size(ACTIVITY_WINDOW_WIDTH, ACTIVITY_WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focusable(false)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())
}

fn show_activity_window(app: &AppHandle) {
    match ensure_activity_window(app) {
        Ok(window) => {
            position_activity_window(app, &window);
            let _ = window.set_always_on_top(true);
            let _ = window.set_focusable(false);
            let _ = window.show();
        }
        Err(error) => eprintln!("Failed to create Finn activity window: {error}"),
    }
}

fn schedule_activity_window_hide(app: &AppHandle, generation: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sleep(ACTIVITY_NATIVE_HIDE_DELAY).await;
        let current_generation = app
            .state::<PuterState>()
            .activity_generation
            .load(Ordering::SeqCst);
        if current_generation == generation {
            hide_activity_window(&app);
        }
    });
}

fn hide_activity_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn resize_activity_window(width: f64, height: f64, app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) else {
        return Ok(());
    };
    let width = width.max(ACTIVITY_WINDOW_WIDTH).ceil();
    let height = height.max(ACTIVITY_WINDOW_HEIGHT).ceil();
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;
    position_activity_window(&app, &window);
    Ok(())
}

fn position_activity_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some(monitor) = activity_monitor(app) else {
        return;
    };
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    let width = (ACTIVITY_WINDOW_WIDTH * scale).round() as i32;
    let height = (ACTIVITY_WINDOW_HEIGHT * scale).round() as i32;
    let margin = (ACTIVITY_WINDOW_MARGIN * scale).round() as i32;
    let x = position.x + size.width as i32 - width - margin;
    let y = position.y + margin;
    let max_y = position.y + size.height as i32 - height - margin;

    let _ = window.set_size(Size::Logical(LogicalSize::new(
        ACTIVITY_WINDOW_WIDTH,
        ACTIVITY_WINDOW_HEIGHT,
    )));
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        x.max(position.x + margin),
        y.min(max_y).max(position.y + margin),
    )));
}

fn activity_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    if let Ok(cursor) = app.cursor_position() {
        if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
            return Some(monitor);
        }
    }

    if let Some(main_window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = main_window.current_monitor() {
            return Some(monitor);
        }
    }

    app.primary_monitor().ok().flatten()
}

pub fn run() {
    tauri::Builder::default()
        .manage(PuterState::new())
        .setup(|app| {
            let tray = create_tray(app.handle())?;
            app.manage(FinnPuterTray { _tray: tray });
            if let Err(error) = ensure_activity_window(app.handle()) {
                eprintln!("Failed to prepare Finn activity window: {error}");
            }
            show_main_window(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            check_authorization,
            complete_setup,
            connect_puter_socket,
            configure_host,
            device_id,
            disconnect_puter_socket,
            fetch_session,
            fetch_puter_config,
            open_privacy_pane,
            request_authorization,
            request_login,
            resize_activity_window,
            saved_puter_state,
            sign_out,
            socket_status,
            sync_access_status,
            update_puter_config,
            verify_login,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Finn Puter")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        apply_configured_host_with, command_output_with_timeout, command_window_end,
        command_window_start, contact_title_for_record, decode_imessage_attributed_body_hex,
        decode_notes_body_hex, http_origin, normalize_host, normalize_local_user_imessage_record,
        normalize_raw_record, path_is_within_root, record_in_command_window, BridgeCommand,
        ContactIdentity, LocalRecord, RawLocalRecord, StoredPuterConfig,
        IMESSAGE_CHAT_VISIBILITY_COLUMNS, IMESSAGE_MESSAGE_VISIBILITY_COLUMNS,
    };
    use flate2::{write::GzEncoder, Compression};
    use serde_json::{json, Value};
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn imessage_visibility_columns_cover_hidden_message_states() {
        assert!(IMESSAGE_MESSAGE_VISIBILITY_COLUMNS.contains(&"is_deleted"));
        assert!(IMESSAGE_MESSAGE_VISIBILITY_COLUMNS.contains(&"date_deleted"));
        assert!(IMESSAGE_MESSAGE_VISIBILITY_COLUMNS.contains(&"date_retracted"));
        assert!(IMESSAGE_MESSAGE_VISIBILITY_COLUMNS.contains(&"is_spam"));
        assert!(IMESSAGE_CHAT_VISIBILITY_COLUMNS.contains(&"is_blackholed"));
        assert!(IMESSAGE_CHAT_VISIBILITY_COLUMNS.contains(&"is_deleted"));
    }

    #[test]
    fn normalize_host_defaults_public_hosts_to_https() {
        assert_eq!(
            normalize_host("finn.meetfinn.cc").unwrap(),
            "https://finn.meetfinn.cc",
        );
        assert_eq!(
            normalize_host("http://finn.meetfinn.cc").unwrap(),
            "https://finn.meetfinn.cc",
        );
    }

    #[test]
    fn normalize_host_keeps_loopback_hosts_on_http() {
        assert_eq!(
            normalize_host("localhost:3000").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_host("127.0.0.1:3000").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(normalize_host("::1").unwrap(), "http://[::1]");
        assert_eq!(normalize_host("[::1]:3000").unwrap(), "http://[::1]:3000");
    }

    #[test]
    fn normalize_host_defaults_non_loopback_hosts_to_https() {
        assert_eq!(
            normalize_host("192.168.1.20:3000").unwrap(),
            "https://192.168.1.20:3000"
        );
        assert_eq!(
            normalize_host("my-mac.local:3000").unwrap(),
            "https://my-mac.local:3000"
        );
    }

    #[test]
    fn normalize_host_preserves_explicit_http_for_private_hosts() {
        assert_eq!(
            normalize_host("http://192.168.1.20:3000").unwrap(),
            "http://192.168.1.20:3000"
        );
        assert_eq!(
            normalize_host("http://10.0.0.5:3000").unwrap(),
            "http://10.0.0.5:3000"
        );
        assert_eq!(
            normalize_host("http://172.16.0.5:3000").unwrap(),
            "http://172.16.0.5:3000"
        );
        assert_eq!(
            normalize_host("http://172.31.255.255:3000").unwrap(),
            "http://172.31.255.255:3000"
        );
        assert_eq!(
            normalize_host("http://169.254.1.10:3000").unwrap(),
            "http://169.254.1.10:3000"
        );
        assert_eq!(
            normalize_host("http://100.64.0.1:3000").unwrap(),
            "http://100.64.0.1:3000"
        );
        assert_eq!(
            normalize_host("http://[fd00::1]:3000").unwrap(),
            "http://[fd00::1]:3000"
        );
        assert_eq!(
            normalize_host("http://[fe80::1]:3000").unwrap(),
            "http://[fe80::1]:3000"
        );
        assert_eq!(
            normalize_host("http://my-mac.local:3000").unwrap(),
            "http://my-mac.local:3000"
        );
        assert_eq!(
            normalize_host("http://finnbox:3000").unwrap(),
            "http://finnbox:3000"
        );
        assert_eq!(
            normalize_host("http://mac.tailnet.ts.net:3000").unwrap(),
            "http://mac.tailnet.ts.net:3000"
        );
    }

    #[test]
    fn normalize_host_upgrades_explicit_public_http_to_https() {
        assert_eq!(
            normalize_host("http://finn.meetfinn.cc").unwrap(),
            "https://finn.meetfinn.cc"
        );
        assert_eq!(
            normalize_host("http://example.com:3000").unwrap(),
            "https://example.com:3000"
        );
        assert_eq!(
            normalize_host("http://172.15.255.255:3000").unwrap(),
            "https://172.15.255.255:3000"
        );
        assert_eq!(
            normalize_host("http://172.32.0.0:3000").unwrap(),
            "https://172.32.0.0:3000"
        );
        assert_eq!(
            normalize_host("http://100.63.255.255:3000").unwrap(),
            "https://100.63.255.255:3000"
        );
        assert_eq!(
            normalize_host("http://100.128.0.1:3000").unwrap(),
            "https://100.128.0.1:3000"
        );
        assert_eq!(
            normalize_host("http://127.example.com:3000").unwrap(),
            "https://127.example.com:3000"
        );
        assert_eq!(
            normalize_host("http://my-mac.local.evil.com:3000").unwrap(),
            "https://my-mac.local.evil.com:3000"
        );
    }

    #[test]
    fn socket_origin_upgrades_public_http_responses_to_https() {
        let public_url =
            reqwest::Url::parse("http://finn.meetfinn.cc/api/web/puter/socket-token").unwrap();
        let local_url =
            reqwest::Url::parse("http://localhost:3000/api/web/puter/socket-token").unwrap();
        let ipv6_local_url =
            reqwest::Url::parse("http://[::1]:3000/api/web/puter/socket-token").unwrap();

        assert_eq!(
            http_origin(&public_url).unwrap(),
            "https://finn.meetfinn.cc"
        );
        assert_eq!(http_origin(&local_url).unwrap(), "http://localhost:3000");
        assert_eq!(http_origin(&ipv6_local_url).unwrap(), "http://[::1]:3000");
    }

    #[test]
    fn configured_host_change_clears_session_token() {
        let mut config = StoredPuterConfig {
            host: Some("https://old.example.com".to_string()),
            device_id: Some("mac-device".to_string()),
            setup_completed: true,
        };
        let mut cleared = false;

        apply_configured_host_with(&mut config, "https://new.example.com".to_string(), || {
            cleared = true;
            Ok(())
        })
        .unwrap();

        assert_eq!(config.host.as_deref(), Some("https://new.example.com"));
        assert_eq!(config.device_id.as_deref(), Some("mac-device"));
        assert!(!config.setup_completed);
        assert!(cleared);
    }

    #[test]
    fn configured_host_keeps_session_token_for_same_host() {
        let mut config = StoredPuterConfig {
            host: Some("https://finn.example.com".to_string()),
            device_id: Some("mac-device".to_string()),
            setup_completed: true,
        };
        let mut cleared = false;

        apply_configured_host_with(&mut config, "https://finn.example.com".to_string(), || {
            cleared = true;
            Ok(())
        })
        .unwrap();

        assert_eq!(config.host.as_deref(), Some("https://finn.example.com"));
        assert_eq!(config.device_id.as_deref(), Some("mac-device"));
        assert!(config.setup_completed);
        assert!(!cleared);
    }

    #[test]
    fn notes_body_decoder_extracts_gzipped_protobuf_note_text() {
        let note = protobuf_length_delimited_field(2, b"Project Atlas\nCall Sam");
        let document = protobuf_length_delimited_field(3, &note);
        let root = protobuf_length_delimited_field(2, &document);
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&root).unwrap();
        let compressed = encoder.finish().unwrap();

        assert_eq!(
            decode_notes_body_hex(&to_hex(&compressed)),
            "Project Atlas\nCall Sam",
        );
    }

    #[test]
    fn command_windows_are_clamped_to_server_scope() {
        let command = test_command(json!({
            "start": "2026-04-01T00:00:00.000Z",
            "end": "2026-06-01T00:00:00.000Z",
        }));

        assert_eq!(command_window_start(&command), "2026-05-01T00:00:00.000Z");
        assert_eq!(command_window_end(&command), "2026-05-17T00:00:00.000Z");

        let narrower = test_command(json!({
            "modifiedAfter": "2026-05-10T00:00:00.000Z",
            "end": "2026-05-12T00:00:00.000Z",
        }));
        assert_eq!(command_window_start(&narrower), "2026-05-10T00:00:00.000Z");
        assert_eq!(command_window_end(&narrower), "2026-05-12T00:00:00.000Z");
    }

    #[test]
    fn notes_records_outside_command_window_are_rejected() {
        let command = test_command(json!({}));
        let inside = test_note_record("note_inside", "2026-05-10T00:00:00.000Z");
        let outside = test_note_record("note_outside", "2026-04-10T00:00:00.000Z");

        assert!(record_in_command_window(&inside, &command));
        assert!(!record_in_command_window(&outside, &command));
    }

    #[test]
    fn attachment_paths_must_stay_under_messages_attachments() {
        let root = PathBuf::from("/Users/test/Library/Messages/Attachments");
        assert!(path_is_within_root(
            &PathBuf::from("/Users/test/Library/Messages/Attachments/a/file.png"),
            &root,
        ));
        assert!(!path_is_within_root(
            &PathBuf::from("/Users/test/Library/Messages/Attachments-evil/file.png"),
            &root,
        ));
        assert!(!path_is_within_root(
            &PathBuf::from("/Users/test/Documents/file.png"),
            &root,
        ));
    }

    #[test]
    fn command_output_with_timeout_drains_large_stdout() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("dd if=/dev/zero bs=1024 count=1024 2>/dev/null");

        let output = command_output_with_timeout(command, Duration::from_secs(5), "large-output")
            .expect("large output should not block on a full pipe");

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 1024 * 1024);
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn decodes_imessage_attributed_body_text() {
        let body = [
            b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\0"
                .as_slice(),
            b"\x84\x84\x08NSObject\0\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+\x10",
            b"Test BEFORE edit",
            b"\x86\x84\x02iI\x01\x10\x92\x84\x84\x84\x0cNSDictionary\0",
        ]
        .concat();

        assert_eq!(
            decode_imessage_attributed_body_hex(&to_hex(&body)).as_deref(),
            Some("Test BEFORE edit"),
        );
    }

    #[test]
    fn normalize_imessage_record_falls_back_to_attributed_body() {
        let attributed_body = [
            b"NSString\x01\x94\x84\x01+\x0f".as_slice(),
            b"hello from blob",
            b"\x86NSDictionary",
        ]
        .concat();
        let record = normalize_raw_record(RawLocalRecord {
            source_type: "imessage".to_string(),
            source_id: "msg_123".to_string(),
            message_id: Some("msg_123".to_string()),
            thread_id: Some("chat_123".to_string()),
            sender: Some("+15551234567".to_string()),
            recipients: Some(json!(["+15557654321"])),
            title: Some("Received iMessage".to_string()),
            timestamp: Some("2026-05-17T00:00:00.000Z".to_string()),
            content: Some("".to_string()),
            attributed_body_hex: Some(to_hex(&attributed_body)),
            attachments: Some(json!([])),
            metadata: Some(json!({ "rowId": 123 })),
        })
        .expect("record should be retained");

        assert_eq!(record.content, "hello from blob");
    }

    #[test]
    fn normalize_imessage_record_parses_sqlite_json_metadata_string() {
        let record = normalize_raw_record(RawLocalRecord {
            source_type: "imessage".to_string(),
            source_id: "msg_metadata".to_string(),
            message_id: Some("msg_metadata".to_string()),
            thread_id: Some("chat_123".to_string()),
            sender: Some("cheyenneu97@gmail.com".to_string()),
            recipients: Some(json!(["cheyenneu97@gmail.com"])),
            title: Some("Baby".to_string()),
            timestamp: Some("2026-05-18T00:46:55.000Z".to_string()),
            content: Some("Yeah\n\nBroccolini".to_string()),
            attributed_body_hex: None,
            attachments: Some(json!([])),
            metadata: Some(Value::String(
                r#"{"isFromMe":1,"rowId":123,"destinationCallerId":"local-user@icloud.com"}"#
                    .to_string(),
            )),
        })
        .expect("record should be retained");

        assert_eq!(record.metadata.get("isFromMe"), Some(&Value::from(1)));
        assert_eq!(
            record
                .metadata
                .get("destinationCallerId")
                .and_then(Value::as_str),
            Some("local-user@icloud.com"),
        );
    }

    #[test]
    fn normalizes_sent_imessage_as_local_user_without_sender_display_metadata() {
        let record = test_imessage_record(
            "msg_sent",
            Some("local-user@icloud.com"),
            json!({
                "isFromMe": 1,
                "senderDisplayName": "Local User",
                "destinationCallerId": "local-user@icloud.com",
            }),
        );

        let normalized = normalize_local_user_imessage_record(record, &[]);

        assert_eq!(normalized.direction.as_deref(), Some("sent_by_user"));
        assert_eq!(normalized.sender.as_deref(), Some("me"));
        assert!(normalized.sender_contact.is_none());
        assert_eq!(
            normalized.metadata.get("localUser"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            normalized
                .metadata
                .get("sourceDirection")
                .and_then(Value::as_str),
            Some("sent_or_authored_by_user"),
        );
        assert_eq!(
            normalized
                .metadata
                .get("localSenderHandle")
                .and_then(Value::as_str),
            Some("local-user@icloud.com"),
        );
        assert!(normalized.metadata.get("senderDisplayName").is_none());
        assert!(normalized.metadata.get("destinationCallerId").is_none());
    }

    #[test]
    fn normalizes_sent_imessage_when_sqlite_sender_is_thread_peer() {
        let record = normalize_raw_record(RawLocalRecord {
            source_type: "imessage".to_string(),
            source_id: "BF099BF9-2022-40A6-B359-2C77DC316BD7".to_string(),
            message_id: Some("BF099BF9-2022-40A6-B359-2C77DC316BD7".to_string()),
            thread_id: Some("any;-;cheyenneu97@gmail.com".to_string()),
            sender: Some("cheyenneu97@gmail.com".to_string()),
            recipients: Some(json!(["cheyenneu97@gmail.com"])),
            title: Some("Baby".to_string()),
            timestamp: Some("2026-05-18T00:46:55.000Z".to_string()),
            content: Some(
                "Yeah\n\nBroccolini\nChicken Thigh\nGolden curry mix\nBoysenberry drumsticks\nx"
                    .to_string(),
            ),
            attributed_body_hex: None,
            attachments: Some(json!([])),
            metadata: Some(Value::String(
                r#"{"isFromMe":1,"senderDisplayName":"Baby","destinationCallerId":"local-user@icloud.com"}"#
                    .to_string(),
            )),
        })
        .expect("record should be retained");

        let normalized = normalize_local_user_imessage_record(record, &[]);

        assert_eq!(normalized.direction.as_deref(), Some("sent_by_user"));
        assert_eq!(normalized.sender.as_deref(), Some("me"));
        assert!(normalized.sender_contact.is_none());
        assert_eq!(
            normalized.metadata.get("localUser"),
            Some(&Value::Bool(true)),
        );
        assert_eq!(
            normalized
                .metadata
                .get("localSenderHandle")
                .and_then(Value::as_str),
            Some("local-user@icloud.com"),
        );
        assert!(normalized.metadata.get("senderDisplayName").is_none());
    }

    #[test]
    fn infers_local_user_from_contacts_my_card_handles() {
        let record = test_imessage_record(
            "msg_inferred",
            Some("local-user@icloud.com"),
            json!({ "isFromMe": 0 }),
        );

        let normalized =
            normalize_local_user_imessage_record(record, &["local-user@icloud.com".to_string()]);

        assert_eq!(normalized.direction.as_deref(), Some("sent_by_user"));
        assert_eq!(normalized.sender.as_deref(), Some("me"));
        assert_eq!(
            normalized.metadata.get("localUser"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            normalized.metadata.get("isFromMeInferred"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            normalized
                .metadata
                .get("localSenderHandle")
                .and_then(Value::as_str),
            Some("local-user@icloud.com"),
        );
    }

    #[test]
    fn keeps_inbound_imessage_sender_from_sqlite_metadata_string() {
        let record = normalize_raw_record(RawLocalRecord {
            source_type: "imessage".to_string(),
            source_id: "msg_inbound_string".to_string(),
            message_id: Some("msg_inbound_string".to_string()),
            thread_id: Some("any;-;cheyenneu97@gmail.com".to_string()),
            sender: Some("cheyenneu97@gmail.com".to_string()),
            recipients: Some(json!(["local-user@icloud.com"])),
            title: Some("Baby".to_string()),
            timestamp: Some("2026-05-18T00:46:10.000Z".to_string()),
            content: Some("Am I getting something for dinner?x".to_string()),
            attributed_body_hex: None,
            attachments: Some(json!([])),
            metadata: Some(Value::String(r#"{"isFromMe":0}"#.to_string())),
        })
        .expect("record should be retained");

        let normalized =
            normalize_local_user_imessage_record(record, &["local-user@icloud.com".to_string()]);

        assert_eq!(normalized.direction, None);
        assert_eq!(normalized.sender.as_deref(), Some("cheyenneu97@gmail.com"));
        assert!(normalized.metadata.get("localUser").is_none());
    }

    #[test]
    fn sent_placeholder_title_prefers_recipient_contact() {
        let sender_contact = ContactIdentity {
            handle: "me".to_string(),
            display_name: "Local User".to_string(),
        };
        let recipient_contacts = vec![ContactIdentity {
            handle: "cheyenneu97@gmail.com".to_string(),
            display_name: "Baby".to_string(),
        }];
        let mut record =
            test_imessage_record("msg_sent_title", Some("me"), json!({ "isFromMe": 1 }));
        record.title = "Sent iMessage".to_string();
        record.recipient_contacts = recipient_contacts.clone();

        assert_eq!(
            contact_title_for_record(&record, Some(&sender_contact), &recipient_contacts),
            Some("Baby".to_string()),
        );
    }

    #[test]
    fn leaves_inbound_imessage_sender_unchanged() {
        let record = test_imessage_record(
            "msg_inbound",
            Some("friend@example.com"),
            json!({ "isFromMe": 0 }),
        );

        let normalized =
            normalize_local_user_imessage_record(record, &["local-user@icloud.com".to_string()]);

        assert_eq!(normalized.direction, None);
        assert_eq!(normalized.sender.as_deref(), Some("friend@example.com"));
        assert_eq!(
            normalized
                .sender_contact
                .as_ref()
                .map(|contact| contact.display_name.as_str()),
            Some("Local User"),
        );
        assert!(normalized.metadata.get("localUser").is_none());
    }

    fn test_command(args: serde_json::Value) -> BridgeCommand {
        BridgeCommand {
            id: "pcmd_test".to_string(),
            toolset: "puter.notes".to_string(),
            command: "get_note".to_string(),
            args,
            window_start: "2026-05-01T00:00:00.000Z".to_string(),
            window_end: "2026-05-17T00:00:00.000Z".to_string(),
            excluded_handles: Vec::new(),
        }
    }

    fn test_note_record(source_id: &str, timestamp: &str) -> LocalRecord {
        LocalRecord {
            source_type: "notes".to_string(),
            source_id: source_id.to_string(),
            message_id: None,
            thread_id: None,
            direction: None,
            sender: None,
            sender_contact: None,
            recipients: Vec::new(),
            recipient_contacts: Vec::new(),
            title: "Test note".to_string(),
            timestamp: timestamp.to_string(),
            content: "note body".to_string(),
            attachments: Vec::new(),
            metadata: json!({}),
        }
    }

    fn test_imessage_record(source_id: &str, sender: Option<&str>, metadata: Value) -> LocalRecord {
        LocalRecord {
            source_type: "imessage".to_string(),
            source_id: source_id.to_string(),
            message_id: Some(source_id.to_string()),
            thread_id: Some("chat_123".to_string()),
            direction: None,
            sender: sender.map(str::to_string),
            sender_contact: sender.map(|handle| ContactIdentity {
                handle: handle.to_string(),
                display_name: "Local User".to_string(),
            }),
            recipients: vec!["+15551234567".to_string()],
            recipient_contacts: Vec::new(),
            title: "Project Atlas".to_string(),
            timestamp: "2026-05-17T00:00:00.000Z".to_string(),
            content: "sent message".to_string(),
            attachments: Vec::new(),
            metadata,
        }
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02X}")).collect()
    }

    fn protobuf_length_delimited_field(field_number: u64, value: &[u8]) -> Vec<u8> {
        let mut bytes = encode_varint((field_number << 3) | 2);
        bytes.extend(encode_varint(value.len() as u64));
        bytes.extend(value);
        bytes
    }

    fn encode_varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }
}
