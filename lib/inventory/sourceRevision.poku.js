import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, describe, test } from "poku";

import { resetRunState } from "../core/runState.js";
import { parseBunLock } from "../ecosystems/bunutils.js";
import { parsePkgJson } from "../ecosystems/parsers-js.js";
import { sourceRevisionOf } from "./sourceRevision.js";

function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("tracked source revisions", () => {
  test("uses the actual tracked workspace repository and leaves untracked copies unresolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-source-revision-"));
    try {
      const manifest = join(root, "package.json");
      const member = join(root, "packages", "helper", "package.json");
      mkdirSync(join(root, "packages", "helper"), { recursive: true });
      writeFileSync(manifest, JSON.stringify({ name: "source-root" }));
      writeFileSync(member, JSON.stringify({ name: "@demo/helper" }));
      const lock = join(root, "bun.lock");
      writeFileSync(lock, JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "source-root" }, "packages/helper": { name: "@demo/helper" } }, packages: { "@demo/helper": ["@demo/helper@workspace:packages/helper"] } }));
      git(root, "init", "-q");
      git(root, "add", "package.json", "packages/helper/package.json", "bun.lock");
      git(root, "commit", "-qm", "fixture");
      const head = git(root, "rev-parse", "HEAD");
      assert.equal(sourceRevisionOf(member).version, head);
      const packageComponent = (await parsePkgJson(manifest, true))[0];
      assert.equal(packageComponent.version, head);
      assert.ok(packageComponent.properties.some((p) => p.name === "cdx:version:kind" && p.value === "source-revision"));
      const parsed = await parseBunLock(lock);
      const workspace = parsed.pkgList.find((p) => p.name === "helper");
      assert.equal(workspace.version, head);
      assert.ok(workspace.properties.some((p) => p.name === "cdx:version:kind"));
      const untracked = join(root, "untracked.json");
      writeFileSync(untracked, "{}");
      assert.equal(sourceRevisionOf(untracked), undefined);
      git(root, "commit", "--allow-empty", "-qm", "next scan");
      resetRunState();
      assert.equal(sourceRevisionOf(member).version, git(root, "rev-parse", "HEAD"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
