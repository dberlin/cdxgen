import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strict as assert, test } from "poku";
import { openNativeOwnerCache } from "./nativeOwnerCache.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
function fixture(run) {
  // A checked owner-private ancestor is part of the real store contract.
  const root = mkdtempSync(join(process.env.HOME, "cdxgen-owner-cache-"));
  try {
    const project = join(root, "project");
    const cache = join(root, "cache");
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(cache, { mode: 0o700 });
    run({ root, project, cache, store: openNativeOwnerCache(cache, project) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("owner slots preserve typed order and aliases across fresh handles", () => fixture(({ cache, project, store }) => {
  const key = digest("owner");
  const shared = { absentLooking: undefined, second: 42 };
  assert.equal(store.read(key), undefined);
  assert.equal(store.write(key, { entries: new Map([["z", shared], ["a", undefined]]), ordered: new Set(["z", "a"]), export: shared, zero: -0 }), true);
  const result = openNativeOwnerCache(cache, project).read(key);
  assert.deepEqual([...result.entries.keys()], ["z", "a"]);
  assert.deepEqual([...result.ordered], ["z", "a"]);
  assert.equal(result.entries.get("z"), result.export);
  assert.equal(Object.hasOwn(result.export, "absentLooking"), true);
  assert.equal(Object.is(result.zero, -0), true);
  assert.equal(result.entries.has("a"), true);
}));

test("owner slots reject corrupt, overlarge, linked, and incomplete records", () => fixture(({ root, cache, store }) => {
  const key = digest("owner");
  assert.equal(store.write(key, { owner: "old" }), true);
  const [name] = readdirSync(cache);
  const slot = join(cache, name);
  const known = readFileSync(slot);
  assert.equal(store.read(`${key.slice(0, 3)}${key[3] === "a" ? "b" : "a"}${key.slice(4)}`), undefined);
  assert.equal(store.write(key, "x".repeat(8 * 1024 * 1024)), false);
  // Visiting each child first must not bypass the logical DAG depth bound.
  const chain = [{}];
  for (let i = 0; i < 80; i++) chain.push({ previous: chain.at(-1) });
  assert.equal(store.write(key, chain), false);
  assert.deepEqual(store.read(key), { owner: "old" });
  const corrupt = Buffer.from(known);
  corrupt[corrupt.length - 1] ^= 1;
  writeFileSync(slot, corrupt);
  assert.equal(store.read(key), undefined);
  writeFileSync(slot, known.subarray(0, -1));
  assert.equal(store.read(key), undefined);
  truncateSync(slot, 8 * 1024 * 1024 + 1);
  assert.equal(store.read(key), undefined);
  rmSync(slot);
  const external = join(root, "intact");
  writeFileSync(external, known, { mode: 0o600 });
  symlinkSync(external, slot);
  assert.equal(store.read(key), undefined);
  rmSync(slot);
  linkSync(external, slot);
  assert.equal(store.read(key), undefined);
  rmSync(slot);
  assert.deepEqual(readFileSync(external), known);
  writeFileSync(slot, "operator evidence, not an owner record", { mode: 0o600 });
  assert.equal(store.write(key, { owner: "new" }), false);
  assert.equal(readFileSync(slot, "utf8"), "operator evidence, not an owner record");
  rmSync(slot);
  assert.equal(store.write(key, { owner: "new" }), true);
  assert.deepEqual(store.read(key), { owner: "new" });
}));

test("owner storage cannot be enabled inside source or below a writable ancestor", () => fixture(({ root, project, cache }) => {
  const nested = join(project, "private");
  mkdirSync(nested, { mode: 0o700 });
  assert.equal(openNativeOwnerCache(nested, project), undefined);
  assert.equal(openNativeOwnerCache(root, project), undefined);
  const publicDir = join(root, "public");
  const privateDir = join(publicDir, "private");
  mkdirSync(publicDir);
  chmodSync(publicDir, 0o777);
  mkdirSync(privateDir, { mode: 0o700 });
  assert.equal(openNativeOwnerCache(privateDir, project), undefined);
  const alias = join(root, "alias");
  symlinkSync(cache, alias, "dir");
  assert.equal(openNativeOwnerCache(alias, project), undefined);
  assert.equal(openNativeOwnerCache(cache, project, [join(cache, "passive-evidence.json")]), undefined);
  assert.equal(openNativeOwnerCache(cache, project, [cache.toUpperCase()]), undefined);
  assert.deepEqual(readdirSync(nested), []);
  assert.deepEqual(readdirSync(privateDir), []);
}));
