-- Empty community business schema. Contains no account, credential or operational data.

CREATE TABLE schema_versions (
  version_id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL
);

CREATE TABLE dictation_contents (
  id TEXT PRIMARY KEY NOT NULL CHECK(
    length(id) = 32 AND
    id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
  ),
  request_ref TEXT NOT NULL UNIQUE,
  key_version TEXT NOT NULL,
  raw_nonce BLOB NOT NULL CHECK(length(raw_nonce) = 12),
  raw_ciphertext BLOB NOT NULL CHECK(length(raw_ciphertext) > 0),
  raw_tag BLOB NOT NULL CHECK(length(raw_tag) = 16),
  final_nonce BLOB NOT NULL CHECK(length(final_nonce) = 12),
  final_ciphertext BLOB NOT NULL CHECK(length(final_ciphertext) > 0),
  final_tag BLOB NOT NULL CHECK(length(final_tag) = 16),
  completed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK(expires_at > completed_at),
  CHECK(deleted_at IS NULL OR deleted_at >= completed_at)
);

CREATE INDEX dictation_contents_expiry_idx
  ON dictation_contents(expires_at, id);
