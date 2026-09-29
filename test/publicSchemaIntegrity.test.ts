import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { applyPublicSchema } from "../src/db/migrator.js";

describe("public database schema integrity", () => {
  it.each(["core", "content"] as const)("accepts an unchanged %s schema", (role) => {
    const database = openDatabase(":memory:");
    try { applyPublicSchema(database, role); expect(() => applyPublicSchema(database, role)).not.toThrow(); }
    finally { database.close(); }
  });

  it.each(["missing", "modified"] as const)("rejects a %s order status guard without repairing it", (kind) => {
    const database = openDatabase(":memory:");
    try {
      applyPublicSchema(database, "core");
      database.exec("DROP TRIGGER billing_orders_status_transition_guard");
      if (kind === "modified") database.exec(`CREATE TRIGGER billing_orders_status_transition_guard
        BEFORE UPDATE ON billing_orders BEGIN SELECT 1; END`);
      const snapshot = database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
      expect(() => applyPublicSchema(database, "core")).toThrow("Database schema structure mismatch");
      expect(database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all()).toEqual(snapshot);
    } finally { database.close(); }
  });

  it.each(["table", "index", "view"] as const)("rejects an additional %s without touching user data", (kind) => {
    const database = openDatabase(":memory:");
    try {
      applyPublicSchema(database, "core");
      database.exec(kind === "table" ? "CREATE TABLE extra_data (value TEXT)" : kind === "index"
        ? "CREATE INDEX extra_user_status ON users(status)" : "CREATE VIEW extra_users AS SELECT id FROM users");
      const before = database.prepare("SELECT count(*) AS count FROM sqlite_schema").get();
      expect(() => applyPublicSchema(database, "core")).toThrow("Database schema structure mismatch");
      expect(database.prepare("SELECT count(*) AS count FROM sqlite_schema").get()).toEqual(before);
    } finally { database.close(); }
  });

  it("rejects a recorded checksum mismatch before schema use", () => {
    const database = openDatabase(":memory:");
    try {
      applyPublicSchema(database, "core");
      database.prepare("UPDATE schema_versions SET checksum = ?").run("0".repeat(64));
      expect(() => applyPublicSchema(database, "core")).toThrow("Database schema version mismatch");
    } finally { database.close(); }
  });
});
