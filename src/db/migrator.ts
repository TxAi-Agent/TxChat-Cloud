import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase, withImmediateTransaction, type SqliteDatabase } from "./database.js";

type SchemaObject = Readonly<{ type: string; name: string; tableName: string; sql: string }>;

function schemaObjects(database: SqliteDatabase): readonly SchemaObject[] {
  const rows = database.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'
    ORDER BY type COLLATE BINARY, name COLLATE BINARY`).all() as SchemaObject[];
  // Preserve SQL string literals and constraints exactly. Only outer whitespace
  // and platform line endings are normalized in both snapshots.
  return rows.map((row) => ({ ...row, sql: row.sql.replaceAll("\r\n", "\n").trim() }));
}

function expectedSchema(sql: string): string {
  const reference = openDatabase(":memory:");
  try {
    reference.exec(sql);
    return JSON.stringify(schemaObjects(reference));
  } finally { reference.close(); }
}

/** A fresh, data-free community baseline. Existing unrelated databases fail closed. */
export function applyPublicSchema(database: SqliteDatabase, role: "core" | "content"): void {
  const sql = readFileSync(fileURLToPath(new URL(`../bootstrap/${role}.sql`, import.meta.url)), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const expected = expectedSchema(sql);
  withImmediateTransaction(database, () => {
    const objects = schemaObjects(database);
    if (objects.length === 0) {
      database.exec(sql);
      database.prepare("INSERT INTO schema_versions (version_id, checksum, applied_at) VALUES (?, ?, ?)")
        .run(`community-${role}-v1`, checksum, new Date().toISOString());
    } else {
      if (!objects.some(({ type, name }) => type === "table" && name === "schema_versions")) {
        throw new Error("Unsupported database schema");
      }
      const version = database.prepare("SELECT checksum FROM schema_versions WHERE version_id = ?")
        .get(`community-${role}-v1`) as { checksum: string } | undefined;
      if (version?.checksum !== checksum) throw new Error("Database schema version mismatch");
    }
    if (JSON.stringify(schemaObjects(database)) !== expected) {
      throw new Error("Database schema structure mismatch");
    }
    if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) {
      throw new Error("Database foreign key validation failed");
    }
  });
}
