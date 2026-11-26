#!/usr/bin/env bun
// Consume operator-approved expanded CMake JSON traces from successful,
// isolated configure-only runs. This tool neither configures nor installs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseCmakeLikeFile } from "../lib/ecosystems/parsers-misc.js";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const bytes = (file) => readFileSync(file);
const trace = (file) => bytes(file).toString().trim().split("\n").map(JSON.parse).filter((event) => event.cmd);
const below = (root, file) => {
  const member = relative(root, file);
  return member && !isAbsolute(member) && member !== ".." && !member.startsWith("../");
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sourceFingerprint = (root, path) => ({ file: relative(root, path), sha256: hash(bytes(path)) });

// Each capture supplies a pinned archive recipe, its actual archive, provider
// trace/cache, and one or more successful finder traces. No normalized
// occurrence rows or alias catalogue are accepted as input.
const [source, output, descriptor] = process.argv.slice(2);
assert(source && output && descriptor, "usage: bun contrib/native-configured-receipts.js SOURCE NEW_BUNDLE CAPTURES_JSON");
const root = realpathSync(source);
const bundle = resolve(output);
assert(!below(root, bundle) && !below(bundle, root) && root !== bundle);
const captures = JSON.parse(bytes(descriptor));
assert(Array.isArray(captures) && captures.length);
mkdirSync(bundle);
const materials = new Map();
function pack(path) {
  const data = bytes(path);
  const sha256 = hash(data);
  const file = `materials/${sha256}/${basename(path)}`;
  if (!materials.has(file)) {
    mkdirSync(dirname(join(bundle, file)), { recursive: true });
    writeFileSync(join(bundle, file), data, { flag: "wx" });
    materials.set(file, { file, sha256 });
  }
  return materials.get(file);
}
const records = [];
for (const capture of captures) {
  const { recipe, archive, providerTrace, cache, finderTraces } = capture;
  assert(below(root, recipe));
  const recipeText = bytes(recipe).toString();
  const pin = /Originally mirrored from: (https:\/\/[^\s]+)\/archive\/([a-f0-9]{40})\.tar\.gz/.exec(recipeText);
  const download = /\bURL\s+(https:\/\/[^\s]+)\s+URL_HASH\s+SHA256=([a-f0-9]{64})/.exec(recipeText);
  assert(pin && download && basename(download[1]) === basename(archive));
  const archiveMaterial = pack(archive);
  assert.equal(archiveMaterial.sha256, download[2]);
  const providerEvents = trace(providerTrace);
  const inputs = new Set([recipe, ...providerEvents.map((event) => event.file).filter((file) => below(root, file))]);
  const configuration = pack(cache);
  const exports = providerEvents.filter((event) => event.cmd === "install" && event.args[0] === "EXPORT" && event.args.includes("NAMESPACE"));
  assert(exports.length);
  for (const finderTrace of finderTraces) {
    const events = trace(finderTrace);
    const finderInputs = [...new Set([...inputs, ...events.map((event) => event.file).filter((file) => below(root, file))])].sort();
    for (const [index, call] of events.entries()) {
      if (call.cmd !== "find_package" || !below(root, call.file) || !call.args.some((arg) => ["CONFIG", "NO_MODULE"].includes(arg))) continue;
      const occurrence = parseCmakeLikeFile(call.file, "generic", { sourceRoot: root }).requirements.find((request) => request.command === call.cmd && request.line === call.line && same(request.arguments, call.args));
      if (!occurrence || occurrence.constraints || occurrence.conditions.includes("analysis-budget-exhausted")) continue;
      const name = call.args[0];
      const end = events.findIndex((event, position) => position > index && event.global_frame <= call.global_frame);
      const nested = events.slice(index + 1, end < 0 ? undefined : end);
      const routes = nested.filter((event) => event.cmd === "find_package" && event.args.join(";").split(";").includes("BYPASS_PROVIDER"));
      const scoped = call.args.indexOf("PATHS");
      let lookupRoot;
      if (scoped !== -1) {
        // Literal, single-root, exclusive search only. Do not turn a
        // variable or an unrestricted HINTS route into an owner assertion.
        if (routes.length || !same(call.args.slice(scoped + 2), ["NO_DEFAULT_PATH"])) continue;
        lookupRoot = call.args[scoped + 1];
      } else {
        if (routes.length !== 1) continue;
        const routed = routes[0].args.join(";").split(";");
        lookupRoot = routed.at(-1);
        if (!same(routed.slice(-5, -1), ["CONFIG", "BYPASS_PROVIDER", "NO_DEFAULT_PATH", "PATHS"]) || routed[0] !== name) continue;
      }
      if (!isAbsolute(lookupRoot) || resolve(lookupRoot) !== lookupRoot) continue;
      const config = nested.find((event) => dirname(event.file) === lookupRoot && [`${name}Config.cmake`, `${name.toLowerCase()}-config.cmake`].includes(basename(event.file)))?.file;
      if (!config) continue;
      const imported = nested.filter((event) => dirname(event.file) === lookupRoot && event.cmd === "add_library" && event.args.includes("IMPORTED"));
      if (imported.length !== 1) continue;
      const target = imported[0].args[0];
      const candidates = exports.filter((event) => target.startsWith(event.args[event.args.indexOf("NAMESPACE") + 1]));
      if (candidates.length !== 1) continue;
      const exported = candidates[0];
      const project = providerEvents.find((event) => event.file === exported.file && event.cmd === "project");
      if (!project || !providerEvents.some((event) => event.file === exported.file && event.cmd === "install" && event.args[0] === "FILES" && event.args.some((arg) => basename(arg) === basename(config)))) continue;
      const { providerCandidates: _, ...identity } = occurrence;
      const configMaterial = pack(config);
      const evidence = [archiveMaterial, configuration, pack(recipe), pack(providerTrace), pack(finderTrace), configMaterial, pack(imported[0].file), pack(exported.file)];
      records.push({ occurrence: identity, sourceSha256: hash(bytes(call.file)), sourceInputs: finderInputs.map((file) => sourceFingerprint(root, file)),
        owner: { name: project.args[0], repository: pin[1], revision: pin[2] }, lookup: { kind: "configured-package", root: lookupRoot, configuration: configuration.sha256 },
        output: { name, target, file: configMaterial.file, capturedFile: config }, evidence: [...new Map(evidence.map((entry) => [entry.file, entry])).values()] });
    }
  }
}
assert(records.length, "no exact configured package observations");
const manifest = join(bundle, "manifest.json");
const data = JSON.stringify({ format: "native-scoped-receipts-v1", sourceRoot: root, records }, null, 2) + "\n";
writeFileSync(manifest, data, { flag: "wx" });
console.log(`${hash(data)}:${manifest}`);
