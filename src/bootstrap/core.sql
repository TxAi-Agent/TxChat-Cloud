-- Empty community business schema. Contains no account, credential or operational data.

CREATE TABLE schema_versions (
  version_id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  phone_lookup TEXT NOT NULL UNIQUE,
  phone_ciphertext TEXT NOT NULL,
  phone_key_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('enabled', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  current_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(current_session_id, id)
    REFERENCES auth_sessions(id, user_id)
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK(
    length(device_id) = 32 AND
    device_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  family_id TEXT NOT NULL UNIQUE CHECK(
    length(family_id) = 32 AND
    family_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  status TEXT NOT NULL CHECK(status IN ('current', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT CHECK(
    revoked_reason IS NULL OR revoked_reason IN (
      'replaced', 'logout', 'replay', 'disabled', 'admin', 'expired'
    )
  ),
  UNIQUE(id, user_id),
  UNIQUE(id, family_id, user_id, device_id),
  CHECK(
    (status = 'current' AND revoked_at IS NULL AND revoked_reason IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);

CREATE TABLE sms_challenges (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  phone_lookup TEXT NOT NULL,
  phone_ciphertext TEXT NOT NULL,
  phone_key_version TEXT NOT NULL,
  otp_verifier TEXT,
  otp_key_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'active', 'consumed', 'provider_rejected', 'superseded',
    'expired', 'exhausted', 'locked'
  )),
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK(wrong_attempts BETWEEN 0 AND 5),
  last_failed_code_verifier TEXT,
  last_verification_attempt_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE TABLE auth_rate_limit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('phone', 'ip')),
  subject_lookup TEXT NOT NULL,
  hmac_key_version TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'send', 'verify_wrong', 'provider_cooldown', 'lock',
    'challenge_exhausted', 'verification_succeeded'
  )),
  occurred_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE invite_attributions (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_lookup TEXT NOT NULL,
  attribution_result TEXT NOT NULL CHECK(
    attribution_result IN ('attributed', 'invalid', 'expired', 'unavailable')
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE refresh_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  session_id TEXT NOT NULL CHECK(
    length(session_id) = 32 AND
    session_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  family_id TEXT NOT NULL CHECK(
    length(family_id) = 32 AND
    family_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK(
    length(device_id) = 32 AND
    device_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('current', 'used', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT CHECK(
    revoked_reason IS NULL OR revoked_reason IN (
      'replaced', 'logout', 'replay', 'disabled', 'admin', 'expired'
    )
  ),
  FOREIGN KEY(session_id, family_id, user_id, device_id)
    REFERENCES auth_sessions(id, family_id, user_id, device_id)
    ON DELETE CASCADE
);

CREATE TABLE refresh_recoveries (
  family_id TEXT NOT NULL CHECK(
    length(family_id) = 32 AND
    family_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  request_ref TEXT NOT NULL,
  source_refresh_session_id TEXT NOT NULL
    REFERENCES refresh_sessions(id) ON DELETE CASCADE,
  source_token_hash TEXT NOT NULL,
  encrypted_result TEXT NOT NULL,
  recovery_key_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(family_id, request_ref)
);

CREATE TABLE dictation_requests (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  request_ref TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(
    status IN ('processing', 'completed', 'failed', 'cancelled')
  ),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  audio_bytes INTEGER CHECK(audio_bytes IS NULL OR audio_bytes >= 0),
  asr_model TEXT,
  rewrite_model TEXT,
  asr_ms INTEGER CHECK(asr_ms IS NULL OR asr_ms >= 0),
  rewrite_ms INTEGER CHECK(rewrite_ms IS NULL OR rewrite_ms >= 0),
  total_ms INTEGER CHECK(total_ms IS NULL OR total_ms >= 0),
  raw_character_count INTEGER CHECK(
    raw_character_count IS NULL OR raw_character_count >= 0
  ),
  final_character_count INTEGER CHECK(
    final_character_count IS NULL OR final_character_count >= 0
  ),
  input_token_count INTEGER CHECK(
    input_token_count IS NULL OR input_token_count >= 0
  ),
  output_token_count INTEGER CHECK(
    output_token_count IS NULL OR output_token_count >= 0
  ),
  error_stage TEXT CHECK(error_stage IS NULL OR error_stage IN (
    'upload', 'audio_validation', 'asr', 'rewrite', 'response', 'cancel'
  )),
  error_code TEXT,
  temporary_cleanup_result TEXT NOT NULL CHECK(
    temporary_cleanup_result IN ('pending', 'succeeded', 'failed', 'not_required')
  ),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(session_id, user_id)
    REFERENCES auth_sessions(id, user_id)
);

CREATE TABLE auth_audit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'challenge_sent', 'provider_rejected', 'verification_failed',
    'verification_succeeded', 'account_created', 'session_replaced',
    'session_rotated', 'session_replayed', 'session_revoked'
  )),
  request_ref TEXT NOT NULL,
  account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES auth_sessions(id) ON DELETE SET NULL,
  account_ref TEXT,
  session_ref TEXT,
  ip_ref TEXT,
  ip_key_version TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'accepted', 'rejected', 'invalid', 'limited', 'success', 'created',
    'replaced', 'rotated', 'replayed', 'revoked'
  )),
  mock_mode INTEGER NOT NULL CHECK(mock_mode IN (0, 1)),
  occurred_at TEXT NOT NULL,
  CHECK(
    (ip_ref IS NULL AND ip_key_version IS NULL) OR
    (ip_ref IS NOT NULL AND ip_key_version IS NOT NULL)
  )
);

CREATE TABLE closed_beta_enrollments (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  phone_lookup TEXT NOT NULL,
  phone_key_version TEXT NOT NULL,
  credential_verifier TEXT,
  credential_key_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(
    status IN ('active', 'consumed', 'revoked', 'expired', 'locked')
  ),
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK(wrong_attempts BETWEEN 0 AND 5),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  terminal_at TEXT,
  consumed_by_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  CHECK(
    (status = 'active' AND credential_verifier IS NOT NULL
      AND terminal_at IS NULL AND consumed_by_user_id IS NULL) OR
    (status = 'consumed' AND credential_verifier IS NULL
      AND terminal_at IS NOT NULL AND consumed_by_user_id IS NOT NULL) OR
    (status IN ('revoked', 'expired', 'locked')
      AND credential_verifier IS NULL AND terminal_at IS NOT NULL
      AND consumed_by_user_id IS NULL)
  )
);

CREATE TABLE closed_beta_enrollment_audit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'verification_failed', 'verification_succeeded', 'consumed',
    'locked', 'revoked', 'expired'
  )),
  request_ref TEXT,
  account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES auth_sessions(id) ON DELETE SET NULL,
  account_ref TEXT,
  session_ref TEXT,
  ip_ref TEXT,
  ip_key_version TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'invalid', 'limited', 'success', 'consumed', 'locked', 'revoked', 'expired'
  )),
  occurred_at TEXT NOT NULL,
  CHECK(
    (event_type = 'verification_failed' AND outcome IN ('invalid', 'limited')) OR
    (event_type = 'verification_succeeded' AND outcome = 'success') OR
    (event_type = 'consumed' AND outcome = 'consumed') OR
    (event_type = 'locked' AND outcome = 'locked') OR
    (event_type = 'revoked' AND outcome = 'revoked') OR
    (event_type = 'expired' AND outcome = 'expired')
  ),
  CHECK(
    (ip_ref IS NULL AND ip_key_version IS NULL) OR
    (ip_ref IS NOT NULL AND ip_key_version IS NOT NULL)
  )
);

CREATE TABLE runtime_model_configurations (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  supersedes_id TEXT REFERENCES runtime_model_configurations(id)
    ON DELETE SET NULL,
  capability TEXT NOT NULL CHECK(capability = 'realtime-asr'),
  provider_kind TEXT NOT NULL CHECK(
    provider_kind IN ('bailian-qwen-realtime', 'bailian-streaming-asr')
  ),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  endpoint TEXT NOT NULL CHECK(length(endpoint) BETWEEN 1 AND 2048),
  model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 128),
  credential_key_version TEXT NOT NULL CHECK(
    length(credential_key_version) BETWEEN 1 AND 64
  ),
  credential_nonce BLOB NOT NULL CHECK(
    typeof(credential_nonce) = 'blob' AND length(credential_nonce) = 12
  ),
  credential_ciphertext BLOB NOT NULL CHECK(
    typeof(credential_ciphertext) = 'blob' AND length(credential_ciphertext) > 0
  ),
  credential_tag BLOB NOT NULL CHECK(
    typeof(credential_tag) = 'blob' AND length(credential_tag) = 16
  ),
  credential_aad_revision INTEGER NOT NULL CHECK(
    typeof(credential_aad_revision) = 'integer' AND credential_aad_revision >= 1
  ),
  revision INTEGER NOT NULL CHECK(
    typeof(revision) = 'integer' AND revision >= 1
  ),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN (
    'draft', 'validating', 'standby', 'active', 'draining',
    'unhealthy', 'pending_deletion'
  )),
  validation_status TEXT NOT NULL CHECK(validation_status IN (
    'not_tested', 'testing', 'passed', 'failed'
  )),
  last_validated_at TEXT,
  delete_when_drained INTEGER NOT NULL DEFAULT 0 CHECK(
    delete_when_drained IN (0, 1)
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(supersedes_id),
  CHECK(supersedes_id IS NULL OR supersedes_id <> id),
  CHECK(
    (validation_status = 'passed' AND last_validated_at IS NOT NULL) OR
    validation_status <> 'passed'
  )
);

CREATE TABLE runtime_model_selections (
  capability TEXT PRIMARY KEY NOT NULL CHECK(capability = 'realtime-asr'),
  active_model_id TEXT REFERENCES runtime_model_configurations(id)
    ON DELETE RESTRICT,
  fallback_model_id TEXT REFERENCES runtime_model_configurations(id)
    ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  CHECK(active_model_id IS NULL OR active_model_id <> fallback_model_id)
);

CREATE TABLE diagnostic_reports (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  external_report_id TEXT NOT NULL UNIQUE,
  payload_digest TEXT NOT NULL CHECK(
    length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  diagnostic_number TEXT NOT NULL UNIQUE CHECK(
    length(diagnostic_number) = 11 AND
    substr(diagnostic_number, 1, 3) = 'TX-' AND
    substr(diagnostic_number, 4) NOT GLOB '*[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]*'
  ),
  installation_ref TEXT NOT NULL CHECK(
    length(installation_ref) = 64 AND installation_ref NOT GLOB '*[^0-9a-f]*'
  ),
  ip_ref TEXT NOT NULL CHECK(
    length(ip_ref) = 64 AND ip_ref NOT GLOB '*[^0-9a-f]*'
  ),
  ip_key_version TEXT NOT NULL CHECK(
    length(ip_key_version) BETWEEN 1 AND 64 AND
    substr(ip_key_version, 1, 1) GLOB '[A-Za-z0-9]' AND
    ip_key_version NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  consent_prompt_version INTEGER NOT NULL CHECK(consent_prompt_version = 1),
  consent_confirmed_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  app_version TEXT NOT NULL CHECK(length(app_version) BETWEEN 1 AND 64),
  app_build TEXT NOT NULL CHECK(
    length(app_build) BETWEEN 1 AND 18 AND app_build NOT GLOB '*[^0-9]*'
  ),
  locale TEXT NOT NULL CHECK(locale IN ('zh-Hans', 'en')),
  architecture TEXT NOT NULL CHECK(
    architecture IN ('arm64', 'x86_64', 'unknown')
  ),
  macos_version TEXT NOT NULL CHECK(length(macos_version) BETWEEN 1 AND 64),
  microphone_permission TEXT NOT NULL CHECK(microphone_permission IN (
    'authorized', 'denied', 'not_determined', 'restricted', 'unknown'
  )),
  accessibility_permission TEXT NOT NULL CHECK(accessibility_permission IN (
    'authorized', 'denied', 'not_determined', 'restricted', 'unknown'
  )),
  service_mode TEXT NOT NULL CHECK(service_mode IN ('txchat_cloud', 'custom')),
  incident_category TEXT NOT NULL CHECK(incident_category IN (
    'application', 'authentication', 'dictation', 'insertion', 'update',
    'custom_asr', 'custom_optimization'
  )),
  incident_task_ref TEXT,
  incident_stage TEXT NOT NULL CHECK(incident_stage IN (
    'lifecycle', 'session_restore', 'session_install', 'session_delete',
    'capture_preflight', 'capture_start', 'stream_start', 'audio_pump',
    'stream_finish', 'final_preparation', 'target_capture',
    'clipboard_transaction', 'event_delivery', 'update_check',
    'update_download', 'update_install', 'provider_configuration',
    'provider_test', 'provider_request', 'provider_response'
  )),
  incident_code TEXT NOT NULL CHECK(incident_code IN (
    'ABNORMAL_EXIT', 'LOCAL_STATE_READ_FAILED', 'LOCAL_STATE_WRITE_FAILED',
    'LOCAL_STATE_DELETE_FAILED', 'PROTOCOL_VIOLATION',
    'AUDIO_CONVERSION_FAILED', 'AUDIO_BUFFER_OVERFLOW',
    'CAPTURE_INTERNAL_FAILURE', 'INSERTION_TRANSACTION_BUSY',
    'PASTEBOARD_SNAPSHOT_FAILED', 'PASTEBOARD_WRITE_FAILED',
    'PASTE_EVENT_FAILED', 'UPDATE_METADATA_INVALID',
    'UPDATE_SIGNATURE_INVALID', 'UPDATE_INSTALL_FAILED',
    'PROVIDER_CONFIGURATION_INVALID', 'PROVIDER_PROTOCOL_VIOLATION',
    'INTERNAL_ERROR'
  ))
, platform TEXT NOT NULL DEFAULT 'macos'
CHECK(platform IN ('macos', 'windows')), os_version TEXT GENERATED ALWAYS AS (macos_version) VIRTUAL);

CREATE TABLE diagnostic_events (
  report_id TEXT NOT NULL REFERENCES diagnostic_reports(id) ON DELETE CASCADE,
  event_index INTEGER NOT NULL CHECK(event_index BETWEEN 0 AND 19),
  occurred_at TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN (
    'application', 'authentication', 'dictation', 'insertion', 'update',
    'custom_asr', 'custom_optimization'
  )),
  task_ref TEXT,
  stage TEXT NOT NULL CHECK(stage IN (
    'lifecycle', 'session_restore', 'session_install', 'session_delete',
    'capture_preflight', 'capture_start', 'stream_start', 'audio_pump',
    'stream_finish', 'final_preparation', 'target_capture',
    'clipboard_transaction', 'event_delivery', 'update_check',
    'update_download', 'update_install', 'provider_configuration',
    'provider_test', 'provider_request', 'provider_response'
  )),
  code TEXT NOT NULL CHECK(code IN (
    'ABNORMAL_EXIT', 'LOCAL_STATE_READ_FAILED', 'LOCAL_STATE_WRITE_FAILED',
    'LOCAL_STATE_DELETE_FAILED', 'PROTOCOL_VIOLATION',
    'AUDIO_CONVERSION_FAILED', 'AUDIO_BUFFER_OVERFLOW',
    'CAPTURE_INTERNAL_FAILURE', 'INSERTION_TRANSACTION_BUSY',
    'PASTEBOARD_SNAPSHOT_FAILED', 'PASTEBOARD_WRITE_FAILED',
    'PASTE_EVENT_FAILED', 'UPDATE_METADATA_INVALID',
    'UPDATE_SIGNATURE_INVALID', 'UPDATE_INSTALL_FAILED',
    'PROVIDER_CONFIGURATION_INVALID', 'PROVIDER_PROTOCOL_VIOLATION',
    'INTERNAL_ERROR'
  )),
  duration_ms INTEGER CHECK(
    duration_ms IS NULL OR
    (typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 3600000)
  ),
  http_status INTEGER CHECK(
    http_status IS NULL OR
    (typeof(http_status) = 'integer' AND http_status BETWEEN 100 AND 599)
  ),
  PRIMARY KEY(report_id, event_index)
);

CREATE TABLE diagnostic_rate_limit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('installation', 'ip')),
  subject_ref TEXT NOT NULL CHECK(
    length(subject_ref) = 64 AND subject_ref NOT GLOB '*[^0-9a-f]*'
  ),
  ip_key_version TEXT CHECK(
    ip_key_version IS NULL OR
    (length(ip_key_version) BETWEEN 1 AND 64 AND
     substr(ip_key_version, 1, 1) GLOB '[A-Za-z0-9]' AND
     ip_key_version NOT GLOB '*[^A-Za-z0-9._-]*')
  ),
  occurred_at TEXT NOT NULL,
  CHECK(
    (subject_kind = 'installation' AND ip_key_version IS NULL) OR
    (subject_kind = 'ip' AND ip_key_version IS NOT NULL)
  )
);

CREATE TABLE sms_admin_account (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  username TEXT NOT NULL CHECK(
    length(username) BETWEEN 4 AND 64 AND
    username NOT GLOB '*[^A-Za-z0-9._]*'
  ),
  password_algorithm TEXT NOT NULL CHECK(password_algorithm = 'scrypt-v1'),
  password_salt BLOB NOT NULL CHECK(
    typeof(password_salt) = 'blob' AND length(password_salt) = 16
  ),
  password_digest BLOB NOT NULL CHECK(
    typeof(password_digest) = 'blob' AND length(password_digest) = 32
  ),
  password_n INTEGER NOT NULL CHECK(password_n = 32768),
  password_r INTEGER NOT NULL CHECK(password_r = 8),
  password_p INTEGER NOT NULL CHECK(password_p = 1),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sms_service_configurations (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  supersedes_id TEXT REFERENCES sms_service_configurations(id)
    ON DELETE SET NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  template_code TEXT NOT NULL CHECK(
    length(template_code) BETWEEN 10 AND 36 AND
    substr(template_code, 1, 4) = 'SMS_' AND
    substr(template_code, 5) NOT GLOB '*[^0-9]*'
  ),
  credential_key_version TEXT NOT NULL,
  credential_nonce BLOB NOT NULL CHECK(
    typeof(credential_nonce) = 'blob' AND length(credential_nonce) = 12
  ),
  credential_ciphertext BLOB NOT NULL CHECK(
    typeof(credential_ciphertext) = 'blob' AND length(credential_ciphertext) > 0
  ),
  credential_tag BLOB NOT NULL CHECK(
    typeof(credential_tag) = 'blob' AND length(credential_tag) = 16
  ),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN (
    'draft', 'active', 'standby', 'retired', 'transition'
  )),
  test_claim_id TEXT,
  test_claimed_at TEXT,
  last_test_outcome TEXT CHECK(
    last_test_outcome IN ('accepted', 'rejected', 'uncertain')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(supersedes_id),
  CHECK(supersedes_id IS NULL OR supersedes_id <> id),
  CHECK(
    (test_claim_id IS NULL AND test_claimed_at IS NULL) OR
    (test_claim_id IS NOT NULL AND test_claimed_at IS NOT NULL)
  )
);

CREATE TABLE sms_admin_bootstrap_tokens (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  purpose TEXT NOT NULL CHECK(purpose IN ('setup', 'password_reset')),
  token_digest BLOB NOT NULL CHECK(
    typeof(token_digest) = 'blob' AND length(token_digest) = 32
  ),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sms_admin_rate_limit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN (
    'account', 'ip', 'account_ip', 'test_phone', 'administrator'
  )),
  subject_lookup TEXT NOT NULL CHECK(length(subject_lookup) = 64),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'login_failed', 'login_succeeded', 'test_attempt', 'suspension'
  )),
  occurred_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE sms_admin_audit (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'initialized', 'login', 'logout', 'password_changed',
    'password_reset', 'draft_saved', 'test_completed', 'activated'
  )),
  result_category TEXT NOT NULL CHECK(length(result_category) BETWEEN 1 AND 48),
  actor_username_snapshot TEXT,
  session_ref TEXT,
  configuration_revision INTEGER,
  occurred_at TEXT NOT NULL
);

CREATE TABLE admin_accounts (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  username TEXT NOT NULL CHECK(length(username) BETWEEN 4 AND 64),
  normalized_username TEXT NOT NULL UNIQUE CHECK(
    length(normalized_username) BETWEEN 4 AND 64
  ),
  account_kind TEXT NOT NULL CHECK(
    account_kind IN ('super_admin', 'administrator')
  ),
  status TEXT NOT NULL CHECK(status IN ('active', 'deleted')),
  password_algorithm TEXT NOT NULL CHECK(password_algorithm = 'scrypt-v1'),
  password_salt BLOB NOT NULL CHECK(
    typeof(password_salt) = 'blob' AND length(password_salt) = 16
  ),
  password_digest BLOB NOT NULL CHECK(
    typeof(password_digest) = 'blob' AND length(password_digest) = 32
  ),
  password_n INTEGER NOT NULL CHECK(password_n = 32768),
  password_r INTEGER NOT NULL CHECK(password_r = 8),
  password_p INTEGER NOT NULL CHECK(password_p = 1),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  password_revision INTEGER NOT NULL CHECK(password_revision >= 1),
  permission_revision INTEGER NOT NULL CHECK(permission_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK(
    (account_kind = 'super_admin' AND status = 'active' AND deleted_at IS NULL) OR
    (account_kind = 'administrator' AND status = 'active' AND deleted_at IS NULL) OR
    (account_kind = 'administrator' AND status = 'deleted' AND deleted_at IS NOT NULL)
  )
);

CREATE TABLE admin_menu_permissions (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  admin_account_id TEXT NOT NULL REFERENCES admin_accounts(id)
    ON DELETE RESTRICT,
  menu_code TEXT NOT NULL CHECK(menu_code IN (
    'users.list', 'versions.list', 'feedback.list', 'offers.list',
    'orders.list', 'models.config', 'sms.config'
  )),
  created_at TEXT NOT NULL,
  UNIQUE(admin_account_id, menu_code)
);

CREATE TABLE admin_account_setup_tokens (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  purpose TEXT NOT NULL CHECK(purpose IN (
    'initial_superadmin', 'reset_superadmin',
    'create_administrator', 'reset_administrator'
  )),
  admin_account_id TEXT REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  token_digest BLOB NOT NULL UNIQUE CHECK(
    typeof(token_digest) = 'blob' AND length(token_digest) = 32
  ),
  issued_by_admin_id TEXT REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at > created_at),
  CHECK(
    (purpose = 'initial_superadmin' AND admin_account_id IS NULL
      AND issued_by_admin_id IS NULL) OR
    (purpose = 'reset_superadmin' AND admin_account_id IS NOT NULL
      AND issued_by_admin_id IS NULL) OR
    (purpose IN ('create_administrator', 'reset_administrator')
      AND issued_by_admin_id IS NOT NULL)
  )
);

CREATE TABLE admin_audit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  occurred_at TEXT NOT NULL,
  actor_admin_id TEXT REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  actor_username_snapshot TEXT,
  target_id TEXT,
  target_username_snapshot TEXT,
  request_ref TEXT,
  action_code TEXT NOT NULL CHECK(action_code IN (
    'setup_issued', 'setup_consumed', 'login', 'logout', 'rate_limited',
    'account_created', 'account_deleted', 'password_reset_issued',
    'password_reset_consumed', 'permissions_changed', 'user_disabled',
    'user_restored', 'release_drafted', 'release_validated',
    'release_published', 'offer_drafted', 'offer_published',
    'offer_scheduled', 'sales_paused', 'sales_resumed', 'model_drafted',
    'refund_recorded',
    'model_tested', 'model_activated', 'model_rolled_back', 'sms_drafted',
    'sms_tested', 'sms_activated', 'sms_rolled_back', 'access_denied',
    'revision_conflict', 'service_failed', 'migration_normalized'
  )),
  result_category TEXT NOT NULL CHECK(length(result_category) BETWEEN 1 AND 48),
  target_revision INTEGER,
  request_correlation TEXT,
  CHECK(actor_admin_id IS NOT NULL OR actor_username_snapshot IS NULL)
);

CREATE TABLE billing_products (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  product_code TEXT NOT NULL UNIQUE,
  sales_state TEXT NOT NULL CHECK(sales_state IN ('paused', 'active')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE billing_offer_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  product_id TEXT NOT NULL REFERENCES billing_products(id) ON DELETE RESTRICT,
  supersedes_id TEXT REFERENCES billing_offer_versions(id) ON DELETE RESTRICT,
  product_code TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  product_type TEXT NOT NULL CHECK(
    product_type IN ('membership', 'addon')
  ),
  tier_code TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency = 'CNY'),
  amount_fen INTEGER NOT NULL CHECK(
    typeof(amount_fen) = 'integer' AND amount_fen > 0
  ),
  quota_amount INTEGER NOT NULL CHECK(
    typeof(quota_amount) = 'integer' AND quota_amount > 0
  ),
  quota_unit TEXT NOT NULL CHECK(quota_unit IN ('milliseconds')),
  included_duration_ms INTEGER NOT NULL CHECK(
    typeof(included_duration_ms) = 'integer' AND included_duration_ms > 0
  ),
  period_unit TEXT NOT NULL CHECK(period_unit IN ('calendar_month', 'calendar_year')),
  period_count INTEGER NOT NULL CHECK(
    typeof(period_count) = 'integer' AND period_count > 0
  ),
  timezone TEXT NOT NULL,
  rollover INTEGER NOT NULL CHECK(rollover IN (0, 1)),
  auto_renew INTEGER NOT NULL CHECK(auto_renew IN (0, 1)),
  active_member_repurchase INTEGER NOT NULL CHECK(
    active_member_repurchase IN (0, 1)
  ),
  effective_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft', 'scheduled', 'active', 'retired')),
  retired_at TEXT,
  created_by_admin_id TEXT REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  created_by_username_snapshot TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(id, product_id),
  UNIQUE(supersedes_id),
  CHECK(supersedes_id IS NULL OR supersedes_id <> id),
  CHECK(
    (state = 'draft' AND published_at IS NULL AND retired_at IS NULL) OR
    (state IN ('scheduled', 'active') AND published_at IS NOT NULL
      AND retired_at IS NULL) OR
    (state = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE TABLE billing_orders (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES billing_products(id) ON DELETE RESTRICT,
  offer_version_id TEXT NOT NULL
    REFERENCES billing_offer_versions(id) ON DELETE RESTRICT,
  offer_product_code TEXT NOT NULL,
  offer_display_name TEXT NOT NULL,
  offer_product_type TEXT NOT NULL,
  offer_tier_code TEXT NOT NULL,
  offer_currency TEXT NOT NULL,
  offer_amount_fen INTEGER NOT NULL CHECK(offer_amount_fen > 0),
  offer_quota_amount INTEGER NOT NULL CHECK(offer_quota_amount > 0),
  offer_quota_unit TEXT NOT NULL,
  offer_included_duration_ms INTEGER NOT NULL CHECK(
    offer_included_duration_ms > 0
  ),
  offer_period_unit TEXT NOT NULL,
  offer_period_count INTEGER NOT NULL CHECK(offer_period_count > 0),
  offer_timezone TEXT NOT NULL,
  offer_rollover INTEGER NOT NULL CHECK(offer_rollover IN (0, 1)),
  offer_auto_renew INTEGER NOT NULL CHECK(offer_auto_renew IN (0, 1)),
  offer_active_member_repurchase INTEGER NOT NULL CHECK(
    offer_active_member_repurchase IN (0, 1)
  ),
  offer_effective_at TEXT NOT NULL,
  offer_state TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(
    typeof(amount_fen) = 'integer' AND amount_fen > 0
  ),
  currency TEXT NOT NULL CHECK(currency = 'CNY'),
  status TEXT NOT NULL CHECK(
    status IN ('pending', 'paid', 'expired', 'refunded', 'payment_exception')
  ),
  idempotency_key_hash TEXT NOT NULL CHECK(length(idempotency_key_hash) = 64),
  wechat_out_trade_no TEXT NOT NULL UNIQUE,
  wechat_transaction_id TEXT UNIQUE,
  wechat_code_url TEXT CHECK(wechat_code_url IS NULL),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  refunded_at TEXT,
  UNIQUE(user_id, idempotency_key_hash),
  UNIQUE(id, user_id),
  FOREIGN KEY(offer_version_id, product_id)
    REFERENCES billing_offer_versions(id, product_id) ON DELETE RESTRICT,
  CHECK(amount_fen = offer_amount_fen AND currency = offer_currency),
  CHECK(
    (status IN ('pending', 'expired') AND paid_at IS NULL
      AND refunded_at IS NULL) OR
    (status = 'paid' AND paid_at IS NOT NULL AND refunded_at IS NULL) OR
    (status = 'refunded' AND paid_at IS NOT NULL AND refunded_at IS NOT NULL) OR
    (status = 'payment_exception' AND refunded_at IS NULL)
  )
);

CREATE TABLE wechat_payment_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  external_notification_id TEXT NOT NULL UNIQUE,
  order_id TEXT REFERENCES billing_orders(id) ON DELETE RESTRICT,
  wechat_transaction_id TEXT,
  amount_fen INTEGER CHECK(
    amount_fen IS NULL OR
    (typeof(amount_fen) = 'integer' AND amount_fen > 0)
  ),
  currency TEXT,
  result TEXT NOT NULL CHECK(result IN ('accepted', 'duplicate', 'rejected')),
  received_at TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE billing_entitlements (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('trial', 'monthly_membership')),
  source_order_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(
    status IN ('active', 'exhausted', 'expired', 'voided', 'refunded')
  ),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  granted_duration_ms INTEGER NOT NULL CHECK(
    typeof(granted_duration_ms) = 'integer' AND granted_duration_ms > 0
  ),
  remaining_duration_ms INTEGER NOT NULL CHECK(
    typeof(remaining_duration_ms) = 'integer' AND
    remaining_duration_ms BETWEEN 0 AND granted_duration_ms
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, user_id),
  FOREIGN KEY(source_order_id, user_id)
    REFERENCES billing_orders(id, user_id) ON DELETE RESTRICT,
  CHECK(
    (kind = 'trial' AND source_order_id IS NULL AND ends_at IS NULL) OR
    (kind = 'monthly_membership' AND source_order_id IS NOT NULL
      AND ends_at IS NOT NULL)
  ),
  CHECK(
    (status = 'active' AND remaining_duration_ms > 0) OR
    (status IN ('exhausted', 'expired', 'voided', 'refunded')
      AND remaining_duration_ms = 0)
  )
);

CREATE TABLE billing_usage_ledger (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL
    REFERENCES billing_entitlements(id) ON DELETE RESTRICT,
  request_ref TEXT,
  dictation_request_id TEXT REFERENCES dictation_requests(id)
    ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'grant', 'consume', 'expire', 'void_trial', 'refund_revoke'
  )),
  duration_ms INTEGER NOT NULL CHECK(
    typeof(duration_ms) = 'integer' AND duration_ms >= 0
  ),
  debited_duration_ms INTEGER CHECK(
    debited_duration_ms IS NULL OR
    (typeof(debited_duration_ms) = 'integer' AND debited_duration_ms >= 0)
  ),
  reason_code TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(entitlement_id, user_id)
    REFERENCES billing_entitlements(id, user_id) ON DELETE RESTRICT,
  CHECK(
    (event_type = 'consume' AND request_ref IS NOT NULL
      AND debited_duration_ms IS NOT NULL) OR
    (event_type <> 'consume' AND debited_duration_ms IS NULL)
  )
);

CREATE TABLE billing_refund_records (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  order_id TEXT NOT NULL REFERENCES billing_orders(id) ON DELETE RESTRICT,
  amount_fen INTEGER NOT NULL CHECK(
    typeof(amount_fen) = 'integer' AND amount_fen > 0
  ),
  wechat_refund_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('recorded', 'confirmed', 'exception')),
  operator_note TEXT NOT NULL CHECK(length(operator_note) BETWEEN 1 AND 240),
  recorded_by_admin_id TEXT REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  recorded_by_username_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  CHECK(
    (status = 'confirmed' AND confirmed_at IS NOT NULL) OR
    (status IN ('recorded', 'exception') AND confirmed_at IS NULL)
  )
);

CREATE TABLE billing_admin_audit (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'login', 'price_published', 'sales_paused', 'sales_resumed',
    'refund_recorded', 'order_repaired'
  )),
  target_id TEXT,
  actor_username_snapshot TEXT,
  result_category TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE billing_admin_rate_limit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('account', 'ip', 'account_ip')),
  subject_lookup TEXT NOT NULL CHECK(length(subject_lookup) = 64),
  event_type TEXT NOT NULL CHECK(event_type = 'login_failed'),
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE admin_offer_remarks (
  offer_id TEXT PRIMARY KEY NOT NULL REFERENCES billing_offer_versions(id) ON DELETE RESTRICT,
  remark TEXT NOT NULL CHECK(length(remark) <= 500),
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_trial_regrant_events (
  request_ref TEXT PRIMARY KEY NOT NULL CHECK(
    length(request_ref) BETWEEN 1 AND 128 AND
    request_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_admin_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  actor_username_snapshot TEXT NOT NULL,
  entitlement_id TEXT NOT NULL REFERENCES billing_entitlements(id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL CHECK(
    typeof(target_revision) = 'integer' AND target_revision >= 1
  ),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX auth_sessions_one_current_user_idx
  ON auth_sessions(user_id) WHERE status = 'current';

CREATE INDEX auth_sessions_family_idx
  ON auth_sessions(family_id, status);

CREATE INDEX sms_challenges_phone_lookup_idx
  ON sms_challenges(phone_lookup, created_at);

CREATE INDEX sms_challenges_terminal_at_idx
  ON sms_challenges(terminal_at);

CREATE INDEX auth_rate_limit_subject_idx
  ON auth_rate_limit_events(
    subject_kind, subject_lookup, event_type, occurred_at
  );

CREATE INDEX auth_rate_limit_expiry_idx
  ON auth_rate_limit_events(expires_at);

CREATE INDEX invite_attributions_user_idx
  ON invite_attributions(user_id, created_at);

CREATE UNIQUE INDEX refresh_sessions_one_current_user_idx
  ON refresh_sessions(user_id) WHERE status = 'current';

CREATE INDEX refresh_sessions_session_idx
  ON refresh_sessions(session_id, status);

CREATE INDEX refresh_sessions_family_idx
  ON refresh_sessions(family_id, status);

CREATE INDEX refresh_recoveries_expiry_idx
  ON refresh_recoveries(expires_at);

CREATE INDEX dictation_requests_session_idx
  ON dictation_requests(session_id, created_at);

CREATE INDEX auth_audit_occurred_at_idx
  ON auth_audit_events(occurred_at);

CREATE UNIQUE INDEX closed_beta_one_active_phone_idx
  ON closed_beta_enrollments(phone_lookup) WHERE status = 'active';

CREATE INDEX closed_beta_terminal_idx
  ON closed_beta_enrollments(terminal_at);

CREATE INDEX closed_beta_audit_occurred_idx
  ON closed_beta_enrollment_audit_events(occurred_at);

CREATE INDEX runtime_model_capability_state_idx
  ON runtime_model_configurations(capability, lifecycle_state);

CREATE INDEX diagnostic_reports_received_idx
  ON diagnostic_reports(received_at, id);

CREATE INDEX diagnostic_reports_installation_idx
  ON diagnostic_reports(installation_ref, received_at);

CREATE INDEX diagnostic_rate_limit_subject_idx
  ON diagnostic_rate_limit_events(
    subject_kind, ip_key_version, subject_ref, occurred_at
  );

CREATE INDEX diagnostic_rate_limit_occurred_idx
  ON diagnostic_rate_limit_events(occurred_at);

CREATE UNIQUE INDEX sms_service_one_draft
  ON sms_service_configurations(lifecycle) WHERE lifecycle = 'draft';

CREATE UNIQUE INDEX sms_service_one_active
  ON sms_service_configurations(lifecycle) WHERE lifecycle = 'active';

CREATE UNIQUE INDEX sms_service_one_standby
  ON sms_service_configurations(lifecycle) WHERE lifecycle = 'standby';

CREATE UNIQUE INDEX sms_admin_one_unconsumed_token
  ON sms_admin_bootstrap_tokens((1)) WHERE consumed_at IS NULL;

CREATE INDEX sms_admin_rate_limit_scope_idx
  ON sms_admin_rate_limit_events(
    scope_kind, subject_lookup, event_type, occurred_at
  );

CREATE INDEX sms_admin_rate_limit_expiry_idx
  ON sms_admin_rate_limit_events(expires_at);

CREATE UNIQUE INDEX admin_accounts_one_superadmin_idx
  ON admin_accounts(account_kind) WHERE account_kind = 'super_admin';

CREATE INDEX admin_audit_events_occurred_idx
  ON admin_audit_events(occurred_at, id);

CREATE UNIQUE INDEX billing_one_active_offer_idx
  ON billing_offer_versions(product_id) WHERE state = 'active';

CREATE UNIQUE INDEX billing_one_scheduled_offer_idx
  ON billing_offer_versions(product_id) WHERE state = 'scheduled';

CREATE UNIQUE INDEX billing_one_pending_order_idx
  ON billing_orders(user_id) WHERE status = 'pending';

CREATE UNIQUE INDEX billing_one_active_membership_idx
  ON billing_entitlements(user_id)
  WHERE kind = 'monthly_membership' AND status IN ('active', 'exhausted');

CREATE UNIQUE INDEX billing_one_consume_per_request_idx
  ON billing_usage_ledger(request_ref) WHERE event_type = 'consume';

CREATE INDEX billing_admin_rate_limit_scope_idx
  ON billing_admin_rate_limit_events(scope_kind, subject_lookup, occurred_at);

CREATE UNIQUE INDEX billing_one_current_trial_per_user_idx
  ON billing_entitlements(user_id)
  WHERE kind = 'trial' AND status IN ('active', 'exhausted');

CREATE TRIGGER billing_offer_versions_published_reject_delete
BEFORE DELETE ON billing_offer_versions
WHEN OLD.state <> 'draft' BEGIN
  SELECT RAISE(ABORT, 'published Offers are immutable');
END;

CREATE TRIGGER billing_offer_versions_published_reject_replace
BEFORE INSERT ON billing_offer_versions
WHEN EXISTS (
  SELECT 1 FROM billing_offer_versions
  WHERE state <> 'draft'
    AND (id = NEW.id OR
      (product_id = NEW.product_id AND supersedes_id = NEW.supersedes_id))
) BEGIN
  SELECT RAISE(ABORT, 'published Offers are immutable');
END;

CREATE TRIGGER billing_orders_snapshot_immutable
BEFORE UPDATE ON billing_orders
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.user_id IS NOT OLD.user_id OR
  NEW.product_id IS NOT OLD.product_id OR
  NEW.offer_version_id IS NOT OLD.offer_version_id OR
  NEW.offer_product_code IS NOT OLD.offer_product_code OR
  NEW.offer_display_name IS NOT OLD.offer_display_name OR
  NEW.offer_product_type IS NOT OLD.offer_product_type OR
  NEW.offer_tier_code IS NOT OLD.offer_tier_code OR
  NEW.offer_currency IS NOT OLD.offer_currency OR
  NEW.offer_amount_fen IS NOT OLD.offer_amount_fen OR
  NEW.offer_quota_amount IS NOT OLD.offer_quota_amount OR
  NEW.offer_quota_unit IS NOT OLD.offer_quota_unit OR
  NEW.offer_included_duration_ms IS NOT OLD.offer_included_duration_ms OR
  NEW.offer_period_unit IS NOT OLD.offer_period_unit OR
  NEW.offer_period_count IS NOT OLD.offer_period_count OR
  NEW.offer_timezone IS NOT OLD.offer_timezone OR
  NEW.offer_rollover IS NOT OLD.offer_rollover OR
  NEW.offer_auto_renew IS NOT OLD.offer_auto_renew OR
  NEW.offer_active_member_repurchase IS NOT OLD.offer_active_member_repurchase OR
  NEW.offer_effective_at IS NOT OLD.offer_effective_at OR
  NEW.offer_state IS NOT OLD.offer_state OR
  NEW.amount_fen IS NOT OLD.amount_fen OR
  NEW.currency IS NOT OLD.currency OR
  NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash OR
  NEW.wechat_out_trade_no IS NOT OLD.wechat_out_trade_no OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'billing order snapshot is immutable');
END;

CREATE TRIGGER billing_orders_write_once_payment_fields
BEFORE UPDATE ON billing_orders
WHEN
  (OLD.wechat_transaction_id IS NOT NULL AND
    NEW.wechat_transaction_id IS NOT OLD.wechat_transaction_id) OR
  (OLD.paid_at IS NOT NULL AND NEW.paid_at IS NOT OLD.paid_at) OR
  (OLD.refunded_at IS NOT NULL AND NEW.refunded_at IS NOT OLD.refunded_at)
BEGIN
  SELECT RAISE(ABORT, 'billing order payment fields are write-once');
END;

CREATE TRIGGER billing_orders_reject_wechat_code_url_insert
BEFORE INSERT ON billing_orders
WHEN NEW.wechat_code_url IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WeChat Native code URLs are memory-only');
END;

CREATE TRIGGER billing_orders_reject_wechat_code_url_update
BEFORE UPDATE OF wechat_code_url ON billing_orders
WHEN NEW.wechat_code_url IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WeChat Native code URLs are memory-only');
END;

CREATE TRIGGER auth_audit_events_reject_update
BEFORE UPDATE ON auth_audit_events BEGIN
  SELECT RAISE(ABORT, 'auth audit events are immutable');
END;

CREATE TRIGGER auth_audit_events_reject_delete
BEFORE DELETE ON auth_audit_events BEGIN
  SELECT RAISE(ABORT, 'auth audit events are immutable');
END;

CREATE TRIGGER closed_beta_audit_reject_update
BEFORE UPDATE ON closed_beta_enrollment_audit_events BEGIN
  SELECT RAISE(ABORT, 'closed beta audit events are immutable');
END;

CREATE TRIGGER closed_beta_audit_reject_delete
BEFORE DELETE ON closed_beta_enrollment_audit_events BEGIN
  SELECT RAISE(ABORT, 'closed beta audit events are immutable');
END;

CREATE TRIGGER sms_admin_audit_reject_update
BEFORE UPDATE ON sms_admin_audit BEGIN
  SELECT RAISE(ABORT, 'legacy sms audit events are immutable');
END;

CREATE TRIGGER sms_admin_audit_reject_delete
BEFORE DELETE ON sms_admin_audit BEGIN
  SELECT RAISE(ABORT, 'legacy sms audit events are immutable');
END;

CREATE TRIGGER billing_admin_audit_reject_update
BEFORE UPDATE ON billing_admin_audit BEGIN
  SELECT RAISE(ABORT, 'legacy billing audit events are immutable');
END;

CREATE TRIGGER billing_admin_audit_reject_delete
BEFORE DELETE ON billing_admin_audit BEGIN
  SELECT RAISE(ABORT, 'legacy billing audit events are immutable');
END;

CREATE TRIGGER billing_refund_records_reject_update
BEFORE UPDATE ON billing_refund_records BEGIN
  SELECT RAISE(ABORT, 'billing refund records are immutable');
END;

CREATE TRIGGER billing_refund_records_reject_delete
BEFORE DELETE ON billing_refund_records BEGIN
  SELECT RAISE(ABORT, 'billing refund records are immutable');
END;

CREATE TRIGGER admin_audit_events_reject_update
BEFORE UPDATE ON admin_audit_events BEGIN
  SELECT RAISE(ABORT, 'admin audit events are immutable');
END;

CREATE TRIGGER admin_audit_events_reject_delete
BEFORE DELETE ON admin_audit_events BEGIN
  SELECT RAISE(ABORT, 'admin audit events are immutable');
END;

CREATE TRIGGER wechat_payment_events_reject_update
BEFORE UPDATE ON wechat_payment_events BEGIN
  SELECT RAISE(ABORT, 'payment events are immutable');
END;

CREATE TRIGGER wechat_payment_events_reject_delete
BEFORE DELETE ON wechat_payment_events BEGIN
  SELECT RAISE(ABORT, 'payment events are immutable');
END;

CREATE TRIGGER billing_usage_ledger_reject_update
BEFORE UPDATE ON billing_usage_ledger BEGIN
  SELECT RAISE(ABORT, 'usage ledger is immutable');
END;

CREATE TRIGGER billing_usage_ledger_reject_delete
BEFORE DELETE ON billing_usage_ledger BEGIN
  SELECT RAISE(ABORT, 'usage ledger is immutable');
END;

CREATE TRIGGER billing_offer_versions_published_fields_immutable
BEFORE UPDATE ON billing_offer_versions
WHEN OLD.state <> 'draft' AND (
  NEW.id IS NOT OLD.id OR
  NEW.product_id IS NOT OLD.product_id OR
  (NEW.supersedes_id IS NOT OLD.supersedes_id AND NOT (OLD.state = 'scheduled' AND NEW.state = 'draft' AND NEW.supersedes_id IS NULL AND NEW.published_at IS NULL AND NEW.retired_at IS NULL AND NEW.revision = OLD.revision + 1)) OR
  NEW.product_code IS NOT OLD.product_code OR
  NEW.display_name IS NOT OLD.display_name OR
  NEW.product_type IS NOT OLD.product_type OR
  NEW.tier_code IS NOT OLD.tier_code OR
  NEW.currency IS NOT OLD.currency OR
  NEW.amount_fen IS NOT OLD.amount_fen OR
  NEW.quota_amount IS NOT OLD.quota_amount OR
  NEW.quota_unit IS NOT OLD.quota_unit OR
  NEW.included_duration_ms IS NOT OLD.included_duration_ms OR
  NEW.period_unit IS NOT OLD.period_unit OR
  NEW.period_count IS NOT OLD.period_count OR
  NEW.timezone IS NOT OLD.timezone OR
  NEW.rollover IS NOT OLD.rollover OR
  NEW.auto_renew IS NOT OLD.auto_renew OR
  NEW.active_member_repurchase IS NOT OLD.active_member_repurchase OR
  NEW.effective_at IS NOT OLD.effective_at OR
  NEW.created_by_admin_id IS NOT OLD.created_by_admin_id OR
  NEW.created_by_username_snapshot IS NOT OLD.created_by_username_snapshot OR
  (NEW.revision IS NOT OLD.revision AND NOT (OLD.state = 'scheduled' AND NEW.state = 'draft' AND NEW.supersedes_id IS NULL AND NEW.published_at IS NULL AND NEW.retired_at IS NULL AND NEW.revision = OLD.revision + 1)) OR
  NEW.created_at IS NOT OLD.created_at OR
  (NEW.published_at IS NOT OLD.published_at AND NOT (OLD.state = 'scheduled' AND NEW.state = 'draft' AND NEW.supersedes_id IS NULL AND NEW.published_at IS NULL AND NEW.retired_at IS NULL AND NEW.revision = OLD.revision + 1))
) BEGIN
  SELECT RAISE(ABORT, 'published Offer fields are immutable');
END;

CREATE TRIGGER billing_offer_versions_published_transition_guard
BEFORE UPDATE ON billing_offer_versions
WHEN OLD.state <> 'draft' AND NOT (
  (OLD.state = 'scheduled' AND NEW.state = 'draft' AND NEW.supersedes_id IS NULL AND NEW.published_at IS NULL AND NEW.retired_at IS NULL AND NEW.revision = OLD.revision + 1) OR
  (OLD.state = 'scheduled' AND NEW.state = 'active'
    AND OLD.retired_at IS NULL AND NEW.retired_at IS NULL) OR
  (OLD.state = 'active' AND NEW.state = 'retired'
    AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
) BEGIN
  SELECT RAISE(ABORT, 'invalid published Offer transition');
END;

CREATE TRIGGER admin_trial_regrant_events_reject_update
BEFORE UPDATE ON admin_trial_regrant_events BEGIN
  SELECT RAISE(ABORT, 'trial regrant audit is append-only');
END;

CREATE TRIGGER admin_trial_regrant_events_reject_delete
BEFORE DELETE ON admin_trial_regrant_events BEGIN
  SELECT RAISE(ABORT, 'trial regrant audit is append-only');
END;

CREATE TRIGGER billing_orders_status_transition_guard
BEFORE UPDATE ON billing_orders
WHEN NOT (
  NEW.status = OLD.status OR
  (OLD.status = 'pending' AND NEW.status IN (
    'expired', 'paid', 'payment_exception'
  )) OR
  (OLD.status = 'expired' AND NEW.status IN (
    'paid', 'payment_exception'
  )) OR
  (OLD.status = 'paid' AND NEW.status IN (
    'payment_exception', 'refunded'
  )) OR
  (OLD.status = 'payment_exception' AND NEW.status = 'refunded') OR
  (OLD.status = 'payment_exception' AND NEW.status = 'expired'
    AND OLD.paid_at IS NULL AND NEW.paid_at IS NULL
    AND OLD.wechat_transaction_id IS NULL AND NEW.wechat_transaction_id IS NULL
    AND OLD.refunded_at IS NULL AND NEW.refunded_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM wechat_payment_events WHERE order_id = OLD.id))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid billing order status transition');
END;
