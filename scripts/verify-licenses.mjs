import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const inventory = JSON.parse(read("licenses/inventory.json"));
const manifest = JSON.parse(read("package.json"));
const notices = read("THIRD_PARTY_NOTICES.md").toString("utf8");
const fail = (message) => { throw new Error(`License review required: ${message}`); };

if (inventory.schemaVersion !== 1) fail("unsupported inventory format");
if (manifest.license !== "Apache-2.0") fail("project license changed");
if (hash(read("pnpm-lock.yaml")) !== inventory.lockfileSha256) {
  fail("lockfile differs from the reviewed dependency closure");
}
if (!notices.includes(inventory.lockfileSha256)) fail("notices reference another lockfile");

for (const scope of ["dependencies", "devDependencies"]) {
  const actual = Object.entries(manifest[scope] ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const expected = inventory.directDependencies.filter((item) => item.scope === scope)
    .map((item) => [item.name, item.version]).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${scope} changed`);
}
if (Object.keys(manifest.optionalDependencies ?? {}).length ||
    Object.keys(manifest.peerDependencies ?? {}).length ||
    (manifest.bundledDependencies?.length ?? 0) || (manifest.bundleDependencies?.length ?? 0)) {
  fail("additional dependency categories are not covered by this inventory");
}
for (const item of inventory.directDependencies) {
  const packageRoot = join("node_modules", item.name);
  const installed = JSON.parse(read(join(packageRoot, "package.json")));
  if (installed.name !== item.name || installed.version !== item.version) fail(`${item.name} installed version changed`);
  if ((installed.license ?? null) !== item.declaredLicense) fail(`${item.name} license declaration changed`);
  if (item.installedLicenseFile && hash(read(join(packageRoot, item.installedLicenseFile))) !== item.licenseSha256) {
    fail(`${item.name} included license changed`);
  }
  if (!notices.includes(`| ${item.name} | ${item.version} |`)) fail(`${item.name} missing from notices`);
}
for (const item of inventory.officialLicenses) {
  if (hash(read(item.path)) !== item.sha256) fail(`${item.path} differs from the reviewed official text`);
  if (item.path.startsWith("licenses/")) {
    const output = join("dist/admin/assets", item.path);
    if (hash(read(output)) !== item.sha256) fail(`${output} differs from its source notice`);
  }
}
console.log(`License verification passed: ${inventory.directDependencies.length} direct dependencies, reviewed lockfile, and ${inventory.officialLicenses.length} official license texts.`);
