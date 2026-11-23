#!/usr/bin/env bun

import process from "node:process";
import { acquireNativeArchiveIdentity } from "../lib/ecosystems/nativeArchiveIdentity.js";

const argumentsByName = new Map();
const allowed = new Set(["--archive", "--url", "--cache", "--source-root"]);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || argumentsByName.has(name)) {
    console.error("Usage: bun contrib/native-archive-identity-cache.js --archive FILE --url URL --cache EXTERNAL_CACHE --source-root SOURCE_ROOT");
    process.exit(2);
  }
  argumentsByName.set(name, value);
}
if (argumentsByName.size !== allowed.size) {
  console.error("Usage: bun contrib/native-archive-identity-cache.js --archive FILE --url URL --cache EXTERNAL_CACHE --source-root SOURCE_ROOT");
  process.exit(2);
}
const identity = await acquireNativeArchiveIdentity(argumentsByName.get("--archive"), argumentsByName.get("--url"), argumentsByName.get("--cache"), argumentsByName.get("--source-root"));
if (!identity) {
  console.error("No unambiguous bounded archive-owned repository/version evidence found; no identity was published.");
  process.exit(1);
}
console.log(JSON.stringify(identity));
