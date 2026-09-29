import { lstatSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildOutput = resolve(repositoryRoot, "dist");

if (relative(repositoryRoot, buildOutput) !== "dist") {
  throw new Error("Build output path is invalid");
}

try {
  const metadata = lstatSync(buildOutput);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Build output must be a real directory");
  }
  rmSync(buildOutput, { recursive: true });
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}
