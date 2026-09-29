import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isMainModule(
  moduleUrl: string,
  entryPath: string | undefined,
): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}
