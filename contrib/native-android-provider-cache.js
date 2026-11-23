import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readRegularTextFile } from "../lib/core/boundedFile.js";
import { parseToml } from "../lib/core/toml.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const immutable = /^[a-f0-9]{40}$/;
const safeName = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const mesaRepository = "https://chromium.googlesource.com/external/gitlab.freedesktop.org/mesa/mesa";
// These are actual source metadata locations, not identity/version assignments.
// Exports are joined from Mesa's hermetic map to the declarations in these files.
const sourceFiles = {
  "platform/system/libbase": ["Android.bp"],
  "platform/system/core": ["libcutils/Android.bp", "libutils/Android.bp"],
  "platform/frameworks/native": ["libs/arect/Android.bp", "libs/nativebase/Android.bp", "libs/nativewindow/Android.bp", "libs/ui/Android.bp", "vulkan/Android.bp"],
  "platform/external/minigbm": ["Android.bp"],
  "platform/hardware/google/gfxstream": ["guest/android-emu/Android.bp", "guest/OpenglCodecCommon/Android.bp", "guest/qemupipe/Android.bp", "guest/renderControl_enc/Android.bp", "guest/gralloc_cb/Android.bp"],
  "platform/hardware/interfaces": ["graphics/mapper/4.0/Android.bp"],
};

/** Read only top-level Blueprint module names, never comments or nested targets. */
function blueprintModules(text) {
  const tokens = (text.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_.-]*|[{}:,]/g) || [])
    .filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i + 1] !== "{") continue;
    const type = tokens[i];
    let depth = 1;
    let name;
    i += 2;
    for (; i < tokens.length && depth; i++) {
      if (tokens[i] === "{") depth++;
      else if (tokens[i] === "}") depth--;
      else if (depth === 1 && tokens[i] === "name" && tokens[i + 1] === ":" && tokens[i + 2]?.startsWith('"')) {
        name = JSON.parse(tokens[i + 2]);
      }
    }
    i--;
    if (name && /^(?:cc_library(?:_shared|_static|_headers)?|hidl_interface)$/.test(type)) result.push({ type, name });
  }
  return result;
}

function descriptor(document) {
  return { path: document.path, sha256: sha256(document.text) };
}

/** Derive exact capabilities from source declarations, without a name/version table. */
export function deriveAndroidProviders({ requirements, mapping, modules, androidMakefile, crossMakefile, commonEvidence = [] }) {
  const wanted = [...new Set(requirements.map((r) => r.requestedName).filter((name) => safeName.test(name || "")))].sort();
  const aliases = new Map();
  const parsed = parseToml(mapping.text);
  for (const section of ["shared_libraries", "static_libraries", "header_libraries"]) {
    for (const [name, declarations] of Object.entries(parsed[section] || {})) {
      if (!Array.isArray(declarations)) continue;
      const targets = declarations.map((d) => d.target_name).filter((target) => safeName.test(target || ""));
      if (targets.length) aliases.set(name, targets);
    }
  }
  const owners = new Map();
  for (const document of modules) {
    if (!immutable.test(document.revision || "") || !document.repository?.startsWith("https://android.googlesource.com/")) continue;
    for (const module of blueprintModules(document.text)) {
      const candidates = owners.get(module.name) || [];
      candidates.push({ ...module, document });
      owners.set(module.name, candidates);
    }
  }
  const generatedPackages = new Map();
  const generator = crossMakefile?.text || "";
  // Verify the real generator writes the declared Name and Version, not merely a
  // list of package names or comments mentioning a .pc file.
  const generatorBody = /^define create-pkgconfig\s*\n([\s\S]*?)^endef\s*$/m.exec(generator)?.[1];
  if (generatorBody && /Name: \$2/.test(generatorBody) && /Version: \$3/.test(generatorBody) && /\$1\/\$2\.pc/.test(generatorBody) &&
      /\$\(foreach pkg,\s*\$\(MESON_GEN_PKGCONFIGS\),\s*\$\(call create-pkgconfig,/.test(generator)) {
    for (const match of (androidMakefile?.text || "").matchAll(/^MESON_GEN_PKGCONFIGS\s*(?::=|\+=)\s*([^\n]*)/gm)) {
      for (const token of match[1].split(/\s+/)) {
        const entry = /^([A-Za-z0-9_.+-]+):(\d+(?:\.\d+)+)$/.exec(token);
        if (entry) generatedPackages.set(entry[1], entry[2]);
      }
    }
  }
  const snapshots = [];
  const missing = [];
  for (const name of wanted) {
    const requirementRows = requirements.filter((r) => r.requestedName === name);
    const interfaceVersion = generatedPackages.get(name);
    const interfaceOwners = interfaceVersion && owners.get(`${name}@${interfaceVersion}`)?.filter((o) => o.type === "hidl_interface");
    if (interfaceOwners?.length === 1) {
      const owner = interfaceOwners[0].document;
      snapshots.push({ schema: 1, name, versionKind: "release", version: interfaceVersion,
        repository: owner.repository, sourceRevision: owner.revision, platform: "android",
        exports: [{ kind: "pkg-config", name }],
        evidence: [...commonEvidence, descriptor(owner), descriptor(androidMakefile), descriptor(crossMakefile)] });
      continue;
    }
    const targets = aliases.get(name);
    if (!targets) {
      missing.push({ name, prerequisite: "No exact Mesa hermetic alias or versioned generated pkg-config/interface export was acquired" });
      continue;
    }
    if (requirementRows.some((r) => (r.constraints || "").trim())) {
      missing.push({ name, prerequisite: "Only an immutable source revision is evidenced; a nonempty requirement constraint needs a genuine release" });
      continue;
    }
    const resolved = targets.map((target) => owners.get(target)?.filter((o) => o.type !== "hidl_interface"));
    if (resolved.some((entries) => entries?.length !== 1)) {
      missing.push({ name, targets, prerequisite: "An owning Android.bp module is missing or ambiguous for the exact hermetic target" });
      continue;
    }
    const entries = resolved.flat();
    if (new Set(entries.map((e) => `${e.document.repository}@${e.document.revision}`)).size !== 1) {
      missing.push({ name, targets, prerequisite: "Hermetic alias combines multiple owning source packages; no single package version can be asserted" });
      continue;
    }
    const owner = entries[0].document;
    snapshots.push({ schema: 1, name, versionKind: "source-revision", version: owner.revision,
      repository: owner.repository, platform: "android",
      exports: [{ kind: "meson-dependency", name }, ...entries.filter((e) => e.type !== "cc_library_headers").map((e) => ({ kind: "library", name: e.name }))],
      evidence: [...commonEvidence, descriptor(mapping), ...[...new Map(entries.map((e) => [e.document.path, e.document])).values()].map(descriptor)] });
  }
  return { snapshots, missing };
}

async function download(url, deadline) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["android.googlesource.com", "chromium.googlesource.com"].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error("Unapproved metadata origin");
  const timeout = Math.min(30000, deadline - Date.now());
  if (timeout <= 0) throw new Error("Android acquisition deadline exceeded");
  const response = await fetch(parsed, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}: ${url}`); }
  const maximum = 4 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("Oversized upstream metadata"); }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) { await response.body.cancel().catch(() => {}); throw new Error("Oversized upstream metadata"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function outsideSource(output, source) {
  let ancestor = output;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, output));
  const rel = relative(realpathSync(source), actual);
  if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("Android cache must be outside source and cdxgen roots");
}

async function main(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fetch") options.set(args[i], true);
    else if (["--requirements", "--output", "--source-root", "--mesa-revision", "--aosp-tag"].includes(args[i]) && args[i + 1]) options.set(args[i], args[++i]);
    else throw new Error(`Unknown or incomplete argument ${args[i]}`);
  }
  if (!["--requirements", "--output", "--source-root", "--mesa-revision", "--aosp-tag"].every((key) => options.has(key))) {
    throw new Error("Usage: bun contrib/native-android-provider-cache.js --requirements remaining.json --output external-cache --source-root readonly-source --mesa-revision <40-char-commit> --aosp-tag android-X.Y.Z_rN [--fetch]");
  }
  const mesaRevision = options.get("--mesa-revision");
  const aospTag = options.get("--aosp-tag");
  if (!immutable.test(mesaRevision) || !/^android-\d+\.\d+\.\d+_r\d+$/.test(aospTag)) throw new Error("A concrete Mesa commit and published Android release tag are required");
  const output = resolve(options.get("--output"));
  outsideSource(output, resolve(options.get("--source-root")));
  outsideSource(output, resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const writer = nativeProviderCacheWriter(output, options.get("--source-root"));
  const inventoryText = readRegularTextFile(resolve(options.get("--requirements")), 32 * 1024 * 1024);
  if (!inventoryText) throw new Error("Missing or oversized requirement inventory");
  const inventory = JSON.parse(inventoryText);
  if (!Array.isArray(inventory)) throw new Error("Expected a frozen requirement inventory array");
  const allRequirements = inventory.flatMap((r) => r.requirements || [r]);
  const deadline = Date.now() + 4 * 60 * 1000;
  const acquisitions = [];
  const inaccessible = [];
  const acquire = async (path, url, format) => {
    let text = readRegularTextFile(join(output, path), 4 * 1024 * 1024, existsSync(output) ? output : undefined);
    if (text === undefined) {
      if (!options.has("--fetch")) throw new Error(`Missing frozen input ${path}; explicit --fetch is required`);
      const raw = await download(url, deadline);
      text = format === "base64" ? Buffer.from(raw.trim(), "base64").toString("utf8") : raw;
      writer.write(path, text);
    }
    acquisitions.push({ path, url, sha256: sha256(text) });
    return { path, text };
  };
  const commit = async (repository, reference, path) => {
    const document = await acquire(path, `${repository}/+/${reference}?format=JSON`);
    const parsed = JSON.parse(document.text.replace(/^\)\]\}'\n/, ""));
    if (!immutable.test(parsed.commit || "") || immutable.test(reference) && parsed.commit !== reference) throw new Error(`Invalid immutable commit metadata for ${repository}`);
    return { document, revision: parsed.commit };
  };
  const mesaCommit = await commit(mesaRepository, mesaRevision, `evidence/mesa/${mesaRevision}/commit.json`);
  const mesaFile = (file) => acquire(`evidence/mesa/${mesaRevision}/${file}`, `${mesaRepository}/+/${mesaRevision}/${file}?format=TEXT`, "base64");
  const [mapping, androidMakefile, crossMakefile] = await Promise.all([
    mesaFile("src/gfxstream/hermetic/android/dependencies.toml"), mesaFile("android/Android.mk"), mesaFile("android/mesa3d_cross.mk"),
  ]);
  const manifestRepository = "https://android.googlesource.com/platform/manifest";
  const manifestCommit = await commit(manifestRepository, `refs/tags/${aospTag}`, `evidence/aosp-manifest/${aospTag}/commit.json`);
  const manifest = await acquire(`evidence/aosp-manifest/${manifestCommit.revision}/default.xml`, `${manifestRepository}/+/${manifestCommit.revision}/default.xml?format=TEXT`, "base64");
  const declaredProjects = new Set([...manifest.text.matchAll(/<project\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]));
  const modules = [];
  const commits = [];
  for (const [project, paths] of Object.entries(sourceFiles)) {
    if (!declaredProjects.has(project)) {
      inaccessible.push({ project, prerequisite: "Owning source project is not declared in the frozen AOSP release manifest" });
      continue;
    }
    const repository = `https://android.googlesource.com/${project}`;
    try {
      const owner = await commit(repository, `refs/tags/${aospTag}`, `evidence/aosp/${project}/${aospTag}/commit.json`);
      commits.push(owner.document);
      const files = await Promise.all(paths.map(async (file) => {
        try {
          const document = await acquire(`evidence/aosp/${project}/${owner.revision}/${file}`, `${repository}/+/${owner.revision}/${file}?format=TEXT`, "base64");
          return { ...document, revision: owner.revision, repository };
        } catch (error) { inaccessible.push({ project, file, prerequisite: error.message }); return undefined; }
      }));
      modules.push(...files.filter(Boolean));
    } catch (error) { inaccessible.push({ project, prerequisite: error.message }); }
  }
  const requirements = allRequirements.filter((r) => /^(?:android-|android\.hardware\.graphics\.)/.test(r.requestedName || "") || ["cutils", "nativewindow", "ui"].includes(r.requestedName));
  const commonEvidence = [mesaCommit.document, manifestCommit.document, manifest, ...commits].map(descriptor);
  const { snapshots, missing } = deriveAndroidProviders({ requirements, mapping, modules, androidMakefile, crossMakefile, commonEvidence });
  const providers = snapshots.map((snapshot) => {
    const path = `${snapshot.name}.json`;
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    writer.write(path, text);
    return { metadata: { path, format: "provider-snapshot", sha256: sha256(text) } };
  });
  const manifestPath = join(output, "native-provider-metadata.json");
  writer.write("native-provider-metadata.json", `${JSON.stringify({ schema: 1, providers }, null, 2)}\n`);
  const report = { schema: 1, mesaRevision, aospTag, sourceRoot: resolve(options.get("--source-root")), selected: false,
    requirementsSha256: sha256(inventoryText), providers: snapshots.map((s) => ({ name: s.name, version: s.version, versionKind: s.versionKind, repository: s.repository, exports: s.exports })),
    missing, inaccessible, acquisitions: acquisitions.sort((a, b) => a.path.localeCompare(b.path)) };
  writer.write("acquisition-report.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ manifest: manifestPath, providers: providers.length, missing, inaccessible }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
