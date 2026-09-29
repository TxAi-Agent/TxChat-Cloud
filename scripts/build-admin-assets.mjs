import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repositoryRoot, "dist", "admin", "assets");
const expectedAssetRoot = resolve(repositoryRoot, "dist/admin/assets");
const require = createRequire(import.meta.url);

function regularSource(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink < 1) {
    throw new Error("Administrator asset source is invalid");
  }
  return path;
}

function destination(path) {
  const resolved = resolve(assetRoot, path);
  const relation = relative(assetRoot, resolved);
  if (relation.startsWith("..") || relation === "" || resolve(assetRoot) !== expectedAssetRoot) {
    throw new Error("Administrator asset destination is invalid");
  }
  return resolved;
}

function copy(source, target) {
  const output = destination(target);
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(regularSource(source), output);
}

function writeTablerIconsStylesheet(source, version) {
  const output = destination("tabler-icons.min.css");
  const original = readFileSync(regularSource(source), "utf8");
  let normalized = original;
  for (const extension of ["woff", "woff2", "ttf"]) {
    const fontPath = `./fonts/tabler-icons.${extension}`;
    normalized = normalized
      .replaceAll(`${fontPath}?v${version}`, fontPath)
      .replaceAll(`${fontPath}?`, fontPath);
  }
  if (
    normalized === original ||
    /url\([^)]*tabler-icons\.(?:woff2?|ttf)[?][^)]*\)/u.test(normalized)
  ) {
    throw new Error("Administrator icon font URLs could not be normalized");
  }
  writeFileSync(output, normalized, { encoding: "utf8", mode: 0o644 });
}

function packageRoot(name) {
  return dirname(require.resolve(`${name}/package.json`));
}

function compileBrowserSources() {
  const compiler = regularSource(join(
    dirname(require.resolve("typescript")),
    "../bin/tsc",
  ));
  const result = spawnSync(
    process.execPath,
    [compiler, "-p", join(repositoryRoot, "tsconfig.admin-web.json")],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    throw new Error("Administrator browser compilation failed");
  }
}

function filesBelow(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Administrator build emitted a symbolic link");
    }
    if (entry.isDirectory()) {
      files.push(...filesBelow(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error("Administrator build emitted an unsupported entry");
    }
  }
  return files;
}

function writeManifest() {
  const files = {};
  for (const name of filesBelow(assetRoot).sort()) {
    if (name === "manifest.json") continue;
    const body = readFileSync(destination(name));
    files[name] = {
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }
  writeFileSync(
    destination("manifest.json"),
    `${JSON.stringify({ files }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
}

export function buildAdminAssets() {
  if (resolve(assetRoot) !== expectedAssetRoot) {
    throw new Error("Administrator asset root is invalid");
  }
  rmSync(assetRoot, { recursive: true, force: true });
  mkdirSync(assetRoot, { recursive: true });
  compileBrowserSources();

  const core = realpathSync(packageRoot("@tabler/core"));
  const icons = realpathSync(packageRoot("@tabler/icons-webfont"));
  const corePackage = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
  const iconsPackage = JSON.parse(readFileSync(join(icons, "package.json"), "utf8"));
  const coreLicense = join(repositoryRoot, "licenses/tabler-core-LICENSE");
  const iconsLicense = join(icons, "LICENSE");
  if (
    corePackage.version !== "1.4.0" ||
    iconsPackage.version !== "3.46.0" ||
    corePackage.license !== "MIT" ||
    !readFileSync(regularSource(coreLicense), "utf8")
      .startsWith("The MIT License (MIT)\n") ||
    !readFileSync(regularSource(iconsLicense), "utf8")
      .startsWith("MIT License\n")
  ) {
    throw new Error("Administrator asset dependency identity is invalid");
  }

  copy(join(core, "dist/css/tabler.min.css"), "tabler.min.css");
  writeTablerIconsStylesheet(
    join(icons, "dist/tabler-icons.min.css"),
    iconsPackage.version,
  );
  for (const extension of ["woff", "woff2", "ttf"]) {
    copy(
      join(icons, `dist/fonts/tabler-icons.${extension}`),
      `fonts/tabler-icons.${extension}`,
    );
  }
  copy(
    join(repositoryRoot, "admin-web/styles/txchat-admin.css"),
    "txchat-admin.css",
  );
  copy(coreLicense, "licenses/tabler-core-LICENSE");
  copy(iconsLicense, "licenses/tabler-icons-LICENSE");
  copy(
    join(repositoryRoot, "licenses/bootstrap-LICENSE"),
    "licenses/bootstrap-LICENSE",
  );
  writeManifest();
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAdminAssets();
}
