import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, describe, it } from "poku";

import { captureCmakeDependencyFacts, captureMesonDependencyFacts } from "./nativeDependencyCapture.js";

const put = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const snapshot = (root) => {
  const rows = [];
  const visit = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) visit(path); else rows.push([path, entry.isSymbolicLink() ? "symlink" : createHash("sha256").update(readFileSync(path)).digest("hex")]); } };
  visit(root);
  return rows;
};
const attempts = [
  ["observations-source", "observations.json", "source"],
  ["log-host", "configure.log", "host"],
  ["capture-parent-source", "capture-parent", "source"],
  ["output-in-build", "facts.json", "host"],
  ["output-parent-source", "output-parent", "source"],
  ["output-parent-host", "output-parent", "host"],
  ["trace-copy-host", "trace.jsonl", "host"],
  ["ast-source", "ast-source", "source"],
];

describe("native capture host-write confinement", () => {
  for (const tool of ["cmake", "meson"]) {
    for (const [label, sink, targetKind] of attempts.filter(row => tool === "cmake" ? row[0] !== "ast-source" : row[0] !== "trace-copy-host")) {
      it(`${tool} does not follow project-created ${label} symlinks outside its build`, () => {
        const root = mkdtempSync(join(tmpdir(), `cdx-capture-security-${tool}-`));
        try {
          const source = join(root, "source");
          const build = join(root, "build");
          const host = join(root, "host");
          put(join(host, "facts.json"), "HOST FACTS SENTINEL\n");
          put(join(host, "sentinel.txt"), "HOST LOG SENTINEL\n");
          const sourceFile = join(source, tool === "cmake" ? "CMakeLists.txt" : "meson.build");
          const target = targetKind === "source" ? sourceFile : join(host, "sentinel.txt");
          let output = join(root, "facts.json");
          let link = join(build, ".cdxgen-native", sink);
          let remove;
          if (sink === "capture-parent") { link = join(build, ".cdxgen-native"); remove = link; }
          if (sink === "facts.json") { output = join(build, "facts.json"); link = output; }
          if (sink === "output-parent") { output = join(build, "redirect", "facts.json"); link = dirname(output); remove = link; }
          const destination = sink.endsWith("parent") || sink === "output-parent" ? targetKind === "source" ? source : host : target;
          const protectedSink = !["facts.json", "output-parent"].includes(sink);
          const sinkName = sink === "ast-source" ? `ast-${createHash("sha256").update(sourceFile).digest("hex").slice(0, 16)}.json` : sink;
          const cmakeLink = protectedSink ? sink === "capture-parent" ? "${_capture}" : "${_capture}/" + sinkName : link;
          const cmakeRemove = sink === "capture-parent" ? "${_capture}" : remove;
          let payload;
          if (tool === "cmake") {
            payload = `cmake_minimum_required(VERSION 3.24)\nproject(Attack NONE)\nfile(WRITE "${join(build, "attack-executed")}" "ran")\nget_filename_component(_capture "$ENV{TMPDIR}" DIRECTORY)\n${cmakeRemove ? `file(REMOVE_RECURSE "${cmakeRemove}")\n` : ""}file(CREATE_LINK "${destination}" "${cmakeLink}" SYMBOLIC RESULT ignored)\n`;
            if (sink === "trace.jsonl") payload += "macro(find_package)\n_find_package(${ARGV})\nendmacro()\n";
          } else {
            const mesonLink = protectedSink ? sink === "capture-parent" ? "evidence" : `evidence / '${sinkName}'` : `'${link}'`;
            payload = `project('attack', version: '1.0')\nevidence = run_command('python3', '-c', 'import os; print(os.path.dirname(os.environ["TMPDIR"]))', check: true).stdout().strip()\nrun_command('touch', '${join(build, "attack-executed")}', check: true)\n${remove ? `run_command('rm', '-rf', ${mesonLink}, check: false)\n` : ""}run_command('ln', '-s', '${destination}', ${mesonLink}, check: false)\n`;
          }
          put(sourceFile, payload);
          const sourceBefore = snapshot(source);
          const hostBefore = snapshot(host);
          try {
            (tool === "cmake" ? captureCmakeDependencyFacts : captureMesonDependencyFacts)({ sourceRoot: source, buildRoot: build, output });
          } catch { /* Rejection is allowed; source/host mutation is not. */ }
          assert.ok(existsSync(join(build, "attack-executed")), "the malicious configure payload must actually execute");
          if (JSON.stringify(snapshot(source)) !== JSON.stringify(sourceBefore) || JSON.stringify(snapshot(host)) !== JSON.stringify(hostBefore))
            console.log(JSON.stringify({ tool, label, sourceChanged: JSON.stringify(snapshot(source)) !== JSON.stringify(sourceBefore), hostChanged: JSON.stringify(snapshot(host)) !== JSON.stringify(hostBefore) }));
          assert.deepEqual(snapshot(source), sourceBefore, "capture must never create or truncate source files");
          assert.deepEqual(snapshot(host), hostBefore, "capture must never create or truncate other host files");
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }
  }

  it("does not follow dangling output or preexisting directory symlinks during prepare/publication", () => {
    for (const variant of ["dangling-output", "output-parent", "build-parent"]) {
      const root = mkdtempSync(join(tmpdir(), "cdx-capture-publication-"));
      try {
        const source = join(root, "source");
        put(join(source, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.24)\nproject(Safe NONE)\n");
        let build = join(root, "build");
        let output = join(root, "facts.json");
        if (variant === "dangling-output") symlinkSync(join(source, "created.json"), output);
        else if (variant === "output-parent") { symlinkSync(source, join(root, "redirect")); output = join(root, "redirect", "created-parent", "facts.json"); }
        else { symlinkSync(source, join(root, "redirect")); build = join(root, "redirect", "created-build"); }
        const before = snapshot(source);
        try { captureCmakeDependencyFacts({ sourceRoot: source, buildRoot: build, output }); } catch { /* Fail closed is expected for directory aliases. */ }
        assert.deepEqual(snapshot(source), before, `${variant} must not reach source through a symlink`);
        assert.equal(existsSync(join(source, "created.json")), false);
        if (existsSync(output) && variant === "dangling-output") assert.equal(lstatSync(output).isSymbolicLink(), false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});
