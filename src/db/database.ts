import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;
export type CoreDatabase = SqliteDatabase;
export type ContentDatabase = SqliteDatabase;

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export function openDatabase(path: string): SqliteDatabase {
  const database = new Database(path);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function withImmediateTransaction<T>(
  database: SqliteDatabase,
  work: () => T,
): T {
  if (database.inTransaction) {
    return work();
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.inTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}
