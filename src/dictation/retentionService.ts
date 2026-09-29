import {
  type ContentDatabase,
  withImmediateTransaction,
} from "../db/database.js";

const DEFAULT_BATCH_SIZE = 500;
const MAXIMUM_BATCH_SIZE = 10_000;

export type ContentRetentionResult = Readonly<{
  contentRowsDeleted: number;
}>;

export type ContentRetentionServiceOptions = Readonly<{
  batchSize?: number;
}>;

export class ContentRetentionService {
  readonly #database: ContentDatabase;
  readonly #batchSize: number;
  readonly #identityColumn: "id" | "request_id";

  constructor(
    database: ContentDatabase,
    options: ContentRetentionServiceOptions = {},
  ) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAXIMUM_BATCH_SIZE
    ) {
      throw new Error("Invalid content retention batch size");
    }
    this.#database = database;
    this.#batchSize = batchSize;
    this.#identityColumn = (
      database.prepare("PRAGMA table_info(dictation_contents)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "request_ref")
      ? "id"
      : "request_id";
  }

  purgeExpired(now: Date): ContentRetentionResult {
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Invalid content retention time");
    }
    const boundary = now.toISOString();
    let contentRowsDeleted = 0;

    while (true) {
      const deleted = withImmediateTransaction(
        this.#database,
        () => {
          const rows = this.#database
            .prepare(
              `SELECT ${this.#identityColumn} AS content_id
               FROM dictation_contents
               WHERE expires_at <= ?
               ORDER BY expires_at, ${this.#identityColumn}
               LIMIT ?`,
            )
            .all(boundary, this.#batchSize) as Array<{
            content_id: string;
          }>;
          if (rows.length === 0) {
            return 0;
          }
          const placeholders = rows.map(() => "?").join(", ");
          return this.#database
            .prepare(
              `DELETE FROM dictation_contents
               WHERE ${this.#identityColumn} IN (${placeholders})`,
            )
            .run(...rows.map((row) => row.content_id)).changes;
        },
      );
      contentRowsDeleted += deleted;
      if (deleted === 0 || deleted < this.#batchSize) {
        break;
      }
    }

    return Object.freeze({ contentRowsDeleted });
  }
}
