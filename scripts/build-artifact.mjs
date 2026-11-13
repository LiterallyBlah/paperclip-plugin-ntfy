#!/usr/bin/env node
/**
 * Builds a self-contained, reproducible install artifact:
 *
 *   artifact/<name>-<version>.tgz  (+ .sha256)
 *
 * The worker and manifest are bundled with esbuild so the package has no
 * runtime dependencies and can be installed by local path, without npm.
 *
 * The bundled `@paperclipai/plugin-sdk` is the exact version pinned in
 * package.json, as installed from pnpm-lock.yaml. Run
 * `pnpm install --frozen-lockfile` first. To target another host release,
 * change the pinned SDK version (`pnpm add -E @paperclipai/plugin-sdk@<version>`)
 * and rebuild.
 *
 * The archive ships LICENSE and THIRD_PARTY_NOTICES.md, which lists every
 * package bundled into dist/ with its licence text.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outRoot = join(root, "artifact");
const stage = join(outRoot, "package");
const tarName = `${pkg.name}-${pkg.version}.tgz`;
const tarPath = join(outRoot, tarName);
const plainTar = join(outRoot, "package.tar");

function fail(message) {
  rmSync(plainTar, { force: true });
  rmSync(tarPath, { force: true });
  rmSync(`${tarPath}.sha256`, { force: true });
  console.error(`build-artifact: ${message}`);
  process.exit(1);
}

// The SDK must be the exact pinned release, installed from the lockfile.
const SDK = "@paperclipai/plugin-sdk";
const sdkVersion = pkg.dependencies?.[SDK];
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(sdkVersion ?? "")) {
  fail(`package.json must pin ${SDK} to an exact version`);
}
const sdkPkgPath = join(root, "node_modules", ...SDK.split("/"), "package.json");
if (!existsSync(sdkPkgPath)) fail(`${SDK} is not installed. Run \`pnpm install --frozen-lockfile\` first.`);
const installedSdk = JSON.parse(readFileSync(sdkPkgPath, "utf8")).version;
if (installedSdk !== sdkVersion) {
  fail(`installed ${SDK}@${installedSdk} does not match the pinned ${sdkVersion}. Run \`pnpm install --frozen-lockfile\`.`);
}

const tarCheck = spawnSync("tar", ["--version"], { encoding: "utf8" });
if (tarCheck.error || tarCheck.status !== 0 || !/GNU tar/.test(tarCheck.stdout ?? "")) {
  fail("GNU tar is required for a reproducible archive (--sort=name, --mtime, --owner). Put GNU tar first on PATH as `tar` (on macOS: `brew install gnu-tar` and use its gnubin directory).");
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

const bundledInputs = new Set();
for (const entry of ["worker", "manifest"]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, "src", `${entry}.ts`)],
    outfile: join(stage, "dist", `${entry}.js`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    sourcemap: false,
    minify: false,
    metafile: true,
    // Some bundled CommonJS dependencies call require() for Node builtins.
    banner: { js: 'import { createRequire as __pcCreateRequire } from "node:module"; const require = __pcCreateRequire(import.meta.url);' },
    logLevel: "warning",
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) bundledInputs.add(input);
  }
}

// Every third-party package that contributed code to dist/.
function packageRootOf(file) {
  let dir = dirname(file);
  while (dir.startsWith(root) && dir !== root) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name && manifest.version) return { dir, manifest };
    }
    dir = dirname(dir);
  }
  return null;
}
const bundled = new Map();
for (const input of bundledInputs) {
  const file = realpathSync(resolve(root, input));
  if (!relative(root, file).split(sep).includes("node_modules")) continue;
  const owner = packageRootOf(file);
  if (!owner) fail(`cannot find the package that owns a bundled file: ${relative(root, file)}`);
  bundled.set(`${owner.manifest.name}@${owner.manifest.version}`, owner);
}
if (![...bundled.keys()].some((id) => id === `${SDK}@${sdkVersion}`)) fail(`${SDK}@${sdkVersion} was not bundled`);

function licenseTextOf({ dir, manifest }) {
  const file = readdirSync(dir).sort().find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  if (file) return readFileSync(join(dir, file), "utf8").trim();
  // @paperclipai/shared is published without a licence file. It comes from the
  // same upstream repository and MIT licence as the plugin SDK, whose package
  // ships that licence text.
  if (manifest.name.startsWith("@paperclipai/") && manifest.license === "MIT") {
    const sdkOwner = bundled.get(`${SDK}@${sdkVersion}`);
    const sdkFile = readdirSync(sdkOwner.dir).sort().find((name) => /^licen[cs]e(\.|$)/i.test(name));
    if (sdkFile) return readFileSync(join(sdkOwner.dir, sdkFile), "utf8").trim();
  }
  fail(`no licence text found for bundled package ${manifest.name}@${manifest.version}`);
}
const notices = [
  "# Third-party notices",
  "",
  `\`dist/\` in this package bundles the following third-party packages. Their`,
  "licences are reproduced below.",
  "",
];
for (const id of [...bundled.keys()].sort()) {
  const owner = bundled.get(id);
  const source = typeof owner.manifest.repository === "string" ? owner.manifest.repository : owner.manifest.repository?.url;
  notices.push(`## ${id}`, "", `- Licence: ${owner.manifest.license ?? "see below"}`);
  if (source) notices.push(`- Source: ${source}`);
  notices.push("", "```text", licenseTextOf(owner), "```", "");
}
writeFileSync(join(stage, "THIRD_PARTY_NOTICES.md"), notices.join("\n"));

const artifactPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  type: "module",
  files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
  engines: pkg.engines,
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(artifactPkg, null, 2)}\n`);
cpSync(join(root, "README.md"), join(stage, "README.md"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));

// Deterministic tarball: sorted entries, fixed mtime/owner, no gzip timestamp.
// tar and gzip run as separate processes so a failure of either one stops the
// build instead of producing a checksum for an empty or partial archive.
function run(cmd, args, stdout) {
  const result = spawnSync(cmd, args, { cwd: outRoot, stdio: ["ignore", stdout, "inherit"] });
  if (result.error) fail(`could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${cmd} failed (${result.signal ? `signal ${result.signal}` : `exit status ${result.status}`})`);
  }
}
run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--mode=u+rwX,go+rX,go-w", "-cf", plainTar, "package"], "inherit");
const tarFd = openSync(tarPath, "w");
try {
  run("gzip", ["-n", "-9", "-c", plainTar], tarFd);
} finally {
  closeSync(tarFd);
}
rmSync(plainTar, { force: true });

const sha = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
writeFileSync(`${tarPath}.sha256`, `${sha}  ${tarName}\n`);
console.log(`${sha}  ${tarName}\nbundled: ${[...bundled.keys()].sort().join(", ")}`);
