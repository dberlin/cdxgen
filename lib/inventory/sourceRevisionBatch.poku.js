import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { strict as assert, test } from "poku";

import { createCppBom } from "../cli/nativeBom.js";
import { setDirWalkCacheRoot } from "../core/fs.js";
import { resetRunState } from "../core/runState.js";
import { execGitMetadata, execGitMetadataBatch } from "./envcontext.js";
import { sourceRevisionOf, sourceRevisionsOf } from "./sourceRevision.js";

function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-revision-batch-"));
  try {
    for (const dir of ["one", "two", "three", "four", "five"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "CMakeLists.txt"), "project(fixture)\n");
      writeFileSync(join(root, dir, "source.txt"), "first\n");
    }
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    resetRunState();
    await run(root);
  } finally {
    setDirWalkCacheRoot(undefined);
    resetRunState();
    rmSync(root, { recursive: true, force: true });
  }
}

// These fixtures change generation-scoped caches, the immutable scan boundary,
// and the process allowlist. Await each test so none can affect another.
await test("returns scoped revisions in request order, not completion order", async () => fixture(async (root) => {
  writeFileSync(join(root, "two", "source.txt"), "dirty source\n");
  const head = git(root, "rev-parse", "HEAD");
  const files = ["three", "two", "one", "three", "four", "five"].map((dir) => join(root, dir, "CMakeLists.txt"));
  files.splice(4, 0, join(root, "one", "untracked.txt"));
  setDirWalkCacheRoot(root);
  const actual = await sourceRevisionsOf(files);
  assert.deepEqual(actual.map((entry) => entry?.subpath), ["three", undefined, "one", "three", undefined, "four", "five"]);
  assert.ok(actual.filter(Boolean).every((entry) => entry.version === head && entry.root === root));
  assert.notEqual(actual[0], actual[3], "each caller receives its own result object");
  assert.deepEqual(actual, files.map(sourceRevisionOf));
  resetRunState();
  assert.deepEqual(await sourceRevisionsOf(files), actual);
}));

await test("never invokes a clean filter to attribute an immutable batch", async () => fixture(async (root) => {
  writeFileSync(join(root, ".gitattributes"), "**/source.txt filter=fixture\n");
  git(root, "add", ".gitattributes");
  git(root, "commit", "-qm", "attributes");
  const marker = join(root, "filter-executed");
  git(root, "config", "filter.fixture.clean", `touch '${marker}'; cat`);
  writeFileSync(join(root, "one", "source.txt"), "changed\n");
  setDirWalkCacheRoot(root);
  assert.deepEqual(await sourceRevisionsOf([join(root, "one", "CMakeLists.txt"), join(root, "two", "CMakeLists.txt")]), [undefined, undefined]);
  assert.equal(existsSync(marker), false);
}));

await test("keeps an unsafe populated submodule out of otherwise independent scopes", async () => fixture(async (root) => fixture(async (provider) => {
  writeFileSync(join(provider, ".gitattributes"), "**/source.txt filter=fixture\n");
  git(provider, "add", ".");
  git(provider, "commit", "-qm", "attributes");
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", provider, "one/submodule");
  git(root, "commit", "-qam", "submodule");
  const child = join(root, "one", "submodule");
  const marker = join(root, "filter-executed");
  git(child, "config", "filter.fixture.clean", `touch '${marker}'; cat`);
  writeFileSync(join(child, "one", "source.txt"), "changed\n");
  setDirWalkCacheRoot(root);
  const files = ["one", "two", "three", "four"].map((dir) => join(root, dir, "CMakeLists.txt"));
  assert.deepEqual((await sourceRevisionsOf(files)).map((entry) => entry?.subpath), [undefined, "two", "three", "four"]);
  assert.equal(existsSync(marker), false);
})));

await test("honors the command allowlist and does not infer blocked revisions", async () => fixture(async (root) => {
  const previous = process.env.CDXGEN_ALLOWED_COMMANDS;
  try {
    process.env.CDXGEN_ALLOWED_COMMANDS = "not-git";
    setDirWalkCacheRoot(root);
    assert.deepEqual(await sourceRevisionsOf([join(root, "one", "CMakeLists.txt"), join(root, "two", "CMakeLists.txt")]), [undefined, undefined]);
  } finally {
    if (previous === undefined) delete process.env.CDXGEN_ALLOWED_COMMANDS;
    else process.env.CDXGEN_ALLOWED_COMMANDS = previous;
  }
}));

await test("returns Git failures and successful empty output as distinct results", async () => fixture(async (root) => {
  setDirWalkCacheRoot(root);
  const commands = ["HEAD", "refs/heads/nonexistent", "HEAD"].map((ref, index) => [root, [
    "--literal-pathspecs", "--no-optional-locks", "diff", "--name-only",
    "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none",
    "-z", ref, "--", index === 2 ? "two" : "one",
  ]]);
  writeFileSync(join(root, "two", "source.txt"), "changed\n");
  const fields = ({ status, signal, stdout, stderr, error }) => ({ status, signal, stdout, stderr, error: error?.message });
  const serial = commands.map(([cwd, args]) => fields(execGitMetadata(cwd, args)));
  const concurrent = (await execGitMetadataBatch(commands)).map(fields);
  assert.deepEqual(concurrent, serial);
  assert.equal(concurrent[0].status, 0);
  assert.equal(concurrent[0].stdout, "");
  assert.notEqual(concurrent[1].status, 0);
  assert.equal(concurrent[2].stdout, "two/source.txt\0");
}));

await test("retains exactly the CMake owner graph when immutable attribution is batched", async () => fixture(async (root) => {
  writeFileSync(join(root, "CMakeLists.txt"), "project(Root VERSION 1.0.0)\nfind_package(one)\n");
  for (const dir of ["one", "two", "three", "four", "five"]) {
    writeFileSync(join(root, dir, "CMakeLists.txt"), `project(${dir}${dir === "three" ? " VERSION 2.0.0" : ""})\n`);
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "projects");
  writeFileSync(join(root, "two", "source.txt"), "changed\n");
  const options = { multiProject: true, installDeps: false, deep: false, specVersion: 1.7 };
  const graph = async () => {
    const { bomJson } = await createCppBom(root, options);
    return { parent: bomJson.metadata.component, components: bomJson.components, dependencies: bomJson.dependencies };
  };
  const serial = await graph();
  const head = git(root, "rev-parse", "HEAD");
  const byName = new Map(serial.parent.components.map((component) => [component.name, component]));
  for (const name of ["one", "four", "five"]) assert.equal(byName.get(name)?.version, head);
  assert.ok(byName.has("two") && !byName.get("two").version);
  assert.equal(byName.get("three")?.version, "2.0.0");
  resetRunState();
  setDirWalkCacheRoot(root);
  assert.deepEqual(await graph(), serial);
}));
