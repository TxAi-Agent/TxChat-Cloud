import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import {
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { insertWithInternalId } from "../ids/sqliteInternalId.js";
import { ModelCredentialCipher } from "./modelCredentialCipher.js";
import type {
  EncryptedModelCredential,
  ModelCapability,
  ModelLifecycleState,
  ModelSelection,
  ModelValidationStatus,
  RuntimeProviderKind,
  SafeModelConfiguration,
} from "./modelTypes.js";

export type ModelConfigurationErrorCode =
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "INVALID_STATE"
  | "ACTIVE_MODEL"
  | "MODEL_BUSY"
  | "LAST_VALIDATED_MODEL"
  | "VALIDATION_REQUIRED"
  | "PERSISTENCE_FAILED";

export class ModelConfigurationError extends Error {
  constructor(readonly code: ModelConfigurationErrorCode) {
    super(code);
    this.name = "ModelConfigurationError";
  }
}

export type CreateModelDraftInput = Readonly<{
  id?: string;
  supersedesId?: string | null;
  capability: ModelCapability;
  providerKind: RuntimeProviderKind;
  displayName: string;
  endpoint: string;
  modelId: string;
  credential: string;
  now: string;
}>;

export type RuntimeModelCredential = Readonly<{
  id: string;
  capability: ModelCapability;
  providerKind: RuntimeProviderKind;
  endpoint: string;
  modelId: string;
  revision: number;
  credentialAADRevision: number;
  encryptedCredential: EncryptedModelCredential;
}>;

type ConfigurationRow = Readonly<{
  id: string;
  supersedes_id: string | null;
  capability: ModelCapability;
  provider_kind: RuntimeProviderKind;
  display_name: string;
  endpoint: string;
  model_id: string;
  credential_key_version: string;
  credential_nonce: Buffer;
  credential_ciphertext: Buffer;
  credential_tag: Buffer;
  credential_aad_revision: number;
  revision: number;
  lifecycle_state: ModelLifecycleState;
  validation_status: ModelValidationStatus;
  last_validated_at: string | null;
  delete_when_drained: 0 | 1;
  created_at: string;
  updated_at: string;
}>;

type SelectionRow = Readonly<{
  capability: ModelCapability;
  active_model_id: string | null;
  fallback_model_id: string | null;
  updated_at: string;
}>;

function fail(code: ModelConfigurationErrorCode): never {
  throw new ModelConfigurationError(code);
}

function external<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ModelConfigurationError) {
      throw error;
    }
    fail("PERSISTENCE_FAILED");
  }
}

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const UTC_LEAP_SECOND_DATES = new Set([
  "1972-06-30",
  "1972-12-31",
  "1973-12-31",
  "1974-12-31",
  "1975-12-31",
  "1976-12-31",
  "1977-12-31",
  "1978-12-31",
  "1979-12-31",
  "1981-06-30",
  "1982-06-30",
  "1983-06-30",
  "1985-06-30",
  "1987-12-31",
  "1989-12-31",
  "1990-12-31",
  "1992-06-30",
  "1993-06-30",
  "1994-06-30",
  "1995-12-31",
  "1997-06-30",
  "1998-12-31",
  "2005-12-31",
  "2008-12-31",
  "2012-06-30",
  "2015-06-30",
  "2016-12-31",
]);

function isKnownLeapSecond(input: Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  offsetSign: string | undefined;
  offsetHour: number;
  offsetMinute: number;
}>): boolean {
  const offsetDirection = input.offsetSign === "-" ? -1 : 1;
  const offsetMilliseconds =
    offsetDirection *
    (input.offsetHour * 60 + input.offsetMinute) *
    60_000;
  const utcBeforeLeapSecond = new Date(0);
  utcBeforeLeapSecond.setUTCFullYear(
    input.year,
    input.month - 1,
    input.day,
  );
  utcBeforeLeapSecond.setUTCHours(input.hour, input.minute, 59, 0);
  utcBeforeLeapSecond.setTime(
    utcBeforeLeapSecond.getTime() - offsetMilliseconds,
  );
  return (
    utcBeforeLeapSecond.getUTCHours() === 23 &&
    utcBeforeLeapSecond.getUTCMinutes() === 59 &&
    utcBeforeLeapSecond.getUTCSeconds() === 59 &&
    UTC_LEAP_SECOND_DATES.has(
      utcBeforeLeapSecond.toISOString().slice(0, 10),
    )
  );
}

function assertRFC3339(timestamp: string): void {
  if (typeof timestamp !== "string" || !timestamp.isWellFormed()) {
    fail("PERSISTENCE_FAILED");
  }
  const match = RFC3339_TIMESTAMP.exec(timestamp);
  if (match === null) {
    fail("PERSISTENCE_FAILED");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    fail("PERSISTENCE_FAILED");
  }
  if (
    second === 60 &&
    !isKnownLeapSecond({
      year,
      month,
      day,
      hour,
      minute,
      offsetSign: match[7],
      offsetHour,
      offsetMinute,
    })
  ) {
    fail("PERSISTENCE_FAILED");
  }
}

function sanitizedEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  return `${parsed.origin}${parsed.pathname}`;
}

function safeConfiguration(row: ConfigurationRow): SafeModelConfiguration {
  return Object.freeze({
    id: row.id,
    supersedesId: row.supersedes_id,
    capability: row.capability,
    providerKind: row.provider_kind,
    displayName: row.display_name,
    endpoint: sanitizedEndpoint(row.endpoint),
    modelId: row.model_id,
    revision: row.revision,
    lifecycleState: row.lifecycle_state,
    validationStatus: row.validation_status,
    lastValidatedAt: row.last_validated_at,
    deleteWhenDrained: row.delete_when_drained === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    credentialConfigured:
      Buffer.isBuffer(row.credential_nonce) &&
      Buffer.isBuffer(row.credential_ciphertext) &&
      row.credential_ciphertext.length > 0 &&
      Buffer.isBuffer(row.credential_tag),
  });
}

function encryptedCredential(
  row: ConfigurationRow,
): EncryptedModelCredential {
  return Object.freeze({
    keyVersion: row.credential_key_version,
    nonce: Buffer.from(row.credential_nonce),
    ciphertext: Buffer.from(row.credential_ciphertext),
    tag: Buffer.from(row.credential_tag),
  });
}

function runtimeCredential(
  row: ConfigurationRow,
): RuntimeModelCredential {
  return Object.freeze({
    id: row.id,
    capability: row.capability,
    providerKind: row.provider_kind,
    endpoint: row.endpoint,
    modelId: row.model_id,
    revision: row.revision,
    credentialAADRevision: row.credential_aad_revision,
    encryptedCredential: encryptedCredential(row),
  });
}

export class ModelConfigurationRepository {
  readonly #phaseOneSchema: boolean;

  constructor(
    private readonly database: CoreDatabase,
    private readonly cipher: ModelCredentialCipher,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {
    this.#phaseOneSchema = (
      this.database.prepare("PRAGMA table_info(admin_accounts)").all() as Array<{
        name: string;
      }>
    ).length > 0;
  }

  createDraft(input: CreateModelDraftInput): SafeModelConfiguration {
    return external(() =>
      withImmediateTransaction(this.database, () => {
        assertRFC3339(input.now);
        const revision = 1;
        const credentialAADRevision = 1;
        const insert = (configurationId: string) => {
          const encrypted = this.cipher.encrypt({
            configurationId,
            capability: input.capability,
            providerKind: input.providerKind,
            revision: credentialAADRevision,
            credential: input.credential,
          });
          return this.database.prepare(
            `INSERT INTO runtime_model_configurations (
              id, supersedes_id, capability, provider_kind, display_name,
              endpoint, model_id, credential_key_version, credential_nonce,
              credential_ciphertext, credential_tag,
              credential_aad_revision, revision,
              lifecycle_state, validation_status, last_validated_at,
              delete_when_drained, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'draft', 'not_tested', NULL, 0, ?, ?
            ) ON CONFLICT(id) DO NOTHING`,
          ).run(
            configurationId,
            input.supersedesId ?? null,
            input.capability,
            input.providerKind,
            input.displayName,
            input.endpoint,
            input.modelId,
            encrypted.keyVersion,
            encrypted.nonce,
            encrypted.ciphertext,
            encrypted.tag,
            credentialAADRevision,
            revision,
            input.now,
            input.now,
          ).changes === 1;
        };
        let configurationId: string;
        if (this.#phaseOneSchema) {
          configurationId = insertWithInternalId({
            generate: this.internalId,
            insert,
          });
        } else {
          if (typeof input.id !== "string" || input.id.length === 0) {
            fail("PERSISTENCE_FAILED");
          }
          if (!insert(input.id)) fail("PERSISTENCE_FAILED");
          configurationId = input.id;
        }
        return safeConfiguration(this.readConfiguration(configurationId));
      }),
    );
  }

  beginValidation(
    id: string,
    expectedRevision: number,
    now: string,
  ): SafeModelConfiguration {
    return external(() =>
      withImmediateTransaction(this.database, () => {
        assertRFC3339(now);
        const current = this.readCurrent(id, expectedRevision);
        const allowedDraft =
          current.lifecycle_state === "draft" &&
          (current.validation_status === "not_tested" ||
            current.validation_status === "failed");
        if (!allowedDraft && current.lifecycle_state !== "unhealthy") {
          fail("INVALID_STATE");
        }
        return this.updateState(current, {
          lifecycleState: "validating",
          validationStatus: "testing",
          lastValidatedAt: null,
          deleteWhenDrained: false,
          now,
        });
      }),
    );
  }

  completeValidation(
    id: string,
    expectedRevision: number,
    result: "passed" | "failed",
    now: string,
  ): SafeModelConfiguration {
    return external(() =>
      withImmediateTransaction(this.database, () => {
        assertRFC3339(now);
        const current = this.readCurrent(id, expectedRevision);
        if (
          current.lifecycle_state !== "validating" ||
          current.validation_status !== "testing" ||
          (result !== "passed" && result !== "failed")
        ) {
          fail("INVALID_STATE");
        }
        return this.updateState(current, {
          lifecycleState: result === "passed" ? "standby" : "draft",
          validationStatus: result,
          lastValidatedAt: result === "passed" ? now : null,
          deleteWhenDrained: false,
          now,
        });
      }),
    );
  }

  activate(
    id: string,
    expectedRevision: number,
    now: string,
    previousActiveLeaseCount?: number,
  ): SafeModelConfiguration {
    return external(() =>
      withImmediateTransaction(this.database, () => {
        assertRFC3339(now);
        if (previousActiveLeaseCount !== undefined) {
          this.assertValidLeaseCount(previousActiveLeaseCount);
        }
        const target = this.readCurrent(id, expectedRevision);
        if (target.validation_status !== "passed") {
          fail("VALIDATION_REQUIRED");
        }
        if (
          target.lifecycle_state !== "standby" ||
          target.delete_when_drained === 1
        ) {
          fail("INVALID_STATE");
        }

        const selection = this.readSelection(target.capability);
        let fallbackModelId = selection?.fallback_model_id ?? null;
        if (selection !== undefined && selection.active_model_id !== null) {
          const oldActive = this.readConfiguration(selection.active_model_id);
          if (
            oldActive.lifecycle_state !== "active" ||
            oldActive.validation_status !== "passed" ||
            oldActive.delete_when_drained === 1
          ) {
            fail("INVALID_STATE");
          }
          this.updateState(oldActive, {
            lifecycleState:
              previousActiveLeaseCount === 0
                ? "standby"
                : "draining",
            validationStatus: oldActive.validation_status,
            lastValidatedAt: oldActive.last_validated_at,
            deleteWhenDrained: false,
            now,
          });
          fallbackModelId = oldActive.id;
        }
        if (fallbackModelId === target.id) {
          fallbackModelId = null;
        }

        const activated = this.updateState(target, {
          lifecycleState: "active",
          validationStatus: "passed",
          lastValidatedAt: target.last_validated_at,
          deleteWhenDrained: false,
          now,
        });
        const selectionUpdated = this.database
          .prepare(
            `INSERT INTO runtime_model_selections (
              capability, active_model_id, fallback_model_id, updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(capability) DO UPDATE SET
              active_model_id = excluded.active_model_id,
              fallback_model_id = excluded.fallback_model_id,
              updated_at = excluded.updated_at`,
          )
          .run(target.capability, target.id, fallbackModelId, now);
        if (selectionUpdated.changes !== 1) {
          fail("PERSISTENCE_FAILED");
        }
        return activated;
      }),
    );
  }

  markUnhealthy(
    id: string,
    expectedRevision: number,
    now: string,
  ): SafeModelConfiguration {
    return external(() =>
      withImmediateTransaction(this.database, () => {
        assertRFC3339(now);
        const current = this.readCurrent(id, expectedRevision);
        if (
          (current.lifecycle_state !== "active" &&
            current.lifecycle_state !== "standby" &&
            current.lifecycle_state !== "draining") ||
          current.validation_status !== "passed"
        ) {
          fail("INVALID_STATE");
        }
        if (current.lifecycle_state === "active") {
          const selection = this.readSelection(current.capability);
          if (selection?.active_model_id !== current.id) {
            fail("INVALID_STATE");
          }
          const fallback =
            selection.fallback_model_id === null
              ? undefined
              : this.readConfiguration(selection.fallback_model_id);
          const canPromoteFallback =
            fallback !== undefined &&
            fallback.validation_status === "passed" &&
            (fallback.lifecycle_state === "draining" ||
              fallback.lifecycle_state === "standby") &&
            fallback.delete_when_drained === 0;
          const unhealthy = this.updateState(current, {
            lifecycleState: "unhealthy",
            validationStatus: current.validation_status,
            lastValidatedAt: current.last_validated_at,
            deleteWhenDrained: current.delete_when_drained === 1,
            now,
          });
          let activeModelId: string | null = null;
          if (canPromoteFallback && fallback !== undefined) {
            this.updateState(fallback, {
              lifecycleState: "active",
              validationStatus: fallback.validation_status,
              lastValidatedAt: fallback.last_validated_at,
              deleteWhenDrained: false,
              now,
            });
            activeModelId = fallback.id;
          }
          const updated = this.database
            .prepare(
              `UPDATE runtime_model_selections
               SET active_model_id = ?, fallback_model_id = NULL,
                   updated_at = ?
               WHERE capability = ? AND active_model_id = ?`,
            )
            .run(activeModelId, now, current.capability, current.id);
          if (updated.changes !== 1) {
            fail("INVALID_STATE");
          }
          return unhealthy;
        }

        const unhealthy = this.updateState(current, {
          lifecycleState: "unhealthy",
          validationStatus: current.validation_status,
          lastValidatedAt: current.last_validated_at,
          deleteWhenDrained: current.delete_when_drained === 1,
          now,
        });
        this.database
          .prepare(
            `UPDATE runtime_model_selections
             SET active_model_id = CASE
                   WHEN active_model_id = ? THEN NULL ELSE active_model_id END,
                 fallback_model_id = CASE
                   WHEN fallback_model_id = ? THEN NULL ELSE fallback_model_id END,
                 updated_at = ?
             WHERE capability = ?
               AND (active_model_id = ? OR fallback_model_id = ?)`,
          )
          .run(id, id, now, current.capability, id, id);
        return unhealthy;
      }),
    );
  }

  requestDeletion(
    id: string,
    expectedRevision: number,
    activeLeaseCount: number,
    now: string,
    whenDrained = false,
  ): SafeModelConfiguration | undefined {
    return external(() =>
      withImmediateTransaction(this.database, () => {
        assertRFC3339(now);
        const current = this.readCurrent(id, expectedRevision);
        this.assertNotActive(current);
        this.assertValidLeaseCount(activeLeaseCount);
        if (current.lifecycle_state === "validating") {
          fail("MODEL_BUSY");
        }
        if (activeLeaseCount > 0) {
          if (!whenDrained) {
            fail("MODEL_BUSY");
          }
          if (
            current.lifecycle_state !== "draining" ||
            current.validation_status !== "passed" ||
            current.delete_when_drained === 1
          ) {
            fail("INVALID_STATE");
          }
          this.assertRetainsValidatedModel(current);
          return this.updateState(current, {
            lifecycleState: "pending_deletion",
            validationStatus: current.validation_status,
            lastValidatedAt: current.last_validated_at,
            deleteWhenDrained: true,
            now,
          });
        }
        this.assertDeletable(current, activeLeaseCount);
        this.deleteConfiguration(current, now);
        return undefined;
      }),
    );
  }

  completeDrain(
    id: string,
    expectedRevision: number,
    activeLeaseCount: number,
    now: string,
  ): SafeModelConfiguration | undefined {
    return external(() =>
      withImmediateTransaction(this.database, () => {
        assertRFC3339(now);
        const current = this.readCurrent(id, expectedRevision);
        if (
          (current.lifecycle_state !== "draining" &&
            current.lifecycle_state !== "pending_deletion") ||
          current.validation_status !== "passed"
        ) {
          fail("INVALID_STATE");
        }
        this.assertZeroLeaseCount(activeLeaseCount);
        if (
          current.lifecycle_state === "pending_deletion" ||
          current.delete_when_drained === 1
        ) {
          this.assertDeletable(current, activeLeaseCount);
          this.deleteConfiguration(current, now);
          return undefined;
        }
        return this.updateState(current, {
          lifecycleState: "standby",
          validationStatus: current.validation_status,
          lastValidatedAt: current.last_validated_at,
          deleteWhenDrained: false,
          now,
        });
      }),
    );
  }

  listSafe(): readonly SafeModelConfiguration[] {
    return external(() =>
      Object.freeze(
        (
          this.database
            .prepare(
              `SELECT * FROM runtime_model_configurations
               ORDER BY created_at, id`,
            )
            .all() as ConfigurationRow[]
        ).map(safeConfiguration),
      ),
    );
  }

  readRuntimeCredential(id: string): RuntimeModelCredential {
    return external(() => runtimeCredential(this.readConfiguration(id)));
  }

  selection(capability: ModelCapability): ModelSelection {
    return external(() => {
      const row = this.readSelection(capability);
      return Object.freeze({
        capability,
        activeModelId: row?.active_model_id ?? null,
        fallbackModelId: row?.fallback_model_id ?? null,
        updatedAt: row?.updated_at ?? null,
      });
    });
  }

  private readConfiguration(id: string): ConfigurationRow {
    const row = this.database
      .prepare(
        `SELECT * FROM runtime_model_configurations WHERE id = ?`,
      )
      .get(id) as ConfigurationRow | undefined;
    if (row === undefined) {
      fail("NOT_FOUND");
    }
    return row;
  }

  private readCurrent(
    id: string,
    expectedRevision: number,
  ): ConfigurationRow {
    const current = this.readConfiguration(id);
    if (current.revision !== expectedRevision) {
      fail("REVISION_CONFLICT");
    }
    return current;
  }

  private readSelection(
    capability: ModelCapability,
  ): SelectionRow | undefined {
    return this.database
      .prepare(
        `SELECT capability, active_model_id, fallback_model_id, updated_at
         FROM runtime_model_selections
         WHERE capability = ?`,
      )
      .get(capability) as SelectionRow | undefined;
  }

  private updateState(
    current: ConfigurationRow,
    next: Readonly<{
      lifecycleState: ModelLifecycleState;
      validationStatus: ModelValidationStatus;
      lastValidatedAt: string | null;
      deleteWhenDrained: boolean;
      now: string;
    }>,
  ): SafeModelConfiguration {
    const nextRevision = current.revision + 1;
    const result = this.database
      .prepare(
        `UPDATE runtime_model_configurations
         SET revision = ?, lifecycle_state = ?, validation_status = ?,
             last_validated_at = ?, delete_when_drained = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        nextRevision,
        next.lifecycleState,
        next.validationStatus,
        next.lastValidatedAt,
        next.deleteWhenDrained ? 1 : 0,
        next.now,
        current.id,
        current.revision,
      );
    if (result.changes !== 1) {
      fail("REVISION_CONFLICT");
    }
    return safeConfiguration(this.readConfiguration(current.id));
  }

  private assertDeletable(
    current: ConfigurationRow,
    activeLeaseCount: number,
  ): void {
    this.assertNotActive(current);
    this.assertZeroLeaseCount(activeLeaseCount);
    if (current.lifecycle_state === "validating") {
      fail("MODEL_BUSY");
    }
    this.assertRetainsValidatedModel(current);
  }

  private assertNotActive(current: ConfigurationRow): void {
    const selection = this.readSelection(current.capability);
    if (
      current.lifecycle_state === "active" ||
      selection?.active_model_id === current.id
    ) {
      fail("ACTIVE_MODEL");
    }
  }

  private assertRetainsValidatedModel(current: ConfigurationRow): void {
    if (current.validation_status === "passed") {
      const remaining = this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM runtime_model_configurations
           WHERE capability = ? AND validation_status = 'passed' AND id <> ?`,
        )
        .get(current.capability, current.id) as { count: number };
      if (remaining.count === 0) {
        fail("LAST_VALIDATED_MODEL");
      }
    }
  }

  private clearSelectionReference(
    capability: ModelCapability,
    id: string,
    now: string,
  ): void {
    this.database
      .prepare(
        `UPDATE runtime_model_selections
         SET active_model_id = CASE
               WHEN active_model_id = ? THEN NULL ELSE active_model_id END,
             fallback_model_id = CASE
               WHEN fallback_model_id = ? THEN NULL ELSE fallback_model_id END,
             updated_at = ?
         WHERE capability = ?
           AND (active_model_id = ? OR fallback_model_id = ?)`,
      )
      .run(id, id, now, capability, id, id);
  }

  private deleteConfiguration(
    current: ConfigurationRow,
    now: string,
  ): void {
    this.clearSelectionReference(current.capability, current.id, now);
    const deleted = this.database
      .prepare(
        `DELETE FROM runtime_model_configurations WHERE id = ?`,
      )
      .run(current.id);
    if (deleted.changes !== 1) {
      fail("PERSISTENCE_FAILED");
    }
  }

  private assertZeroLeaseCount(activeLeaseCount: number): void {
    if (
      !Number.isSafeInteger(activeLeaseCount) ||
      activeLeaseCount !== 0
    ) {
      fail("MODEL_BUSY");
    }
  }

  private assertValidLeaseCount(activeLeaseCount: number): void {
    if (
      !Number.isSafeInteger(activeLeaseCount) ||
      activeLeaseCount < 0
    ) {
      fail("MODEL_BUSY");
    }
  }
}
