#!/usr/bin/env bun
// Explicit acquisition only. Normal BOM generation reads this cache offline.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as loadYaml } from "yaml";

import { parsePurlLoose } from "../lib/inventory/purl.js";

const repository = "https://github.com/conan-io/conan-center-index";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const validName = (name) => /^[a-zA-Z0-9_+.-]+$/.test(name) && name !== "." && name !== "..";

async function boundedFetch(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000), headers: { Accept: "application/vnd.github+json", "User-Agent": "cdxgen-native-canonical-cache" },
  });
  if (!response.ok) throw new Error(`${response.status} acquiring ${url}`);
  if (Number(response.headers.get("content-length")) > 512 * 1024) throw new Error(`Oversized recipe: ${url}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) throw new Error(`Oversized recipe: ${url}`);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Acquire raw recipe data, never execute Conan/Python or alter the source/BOM. */
export async function acquireNativeCanonicalRecipes({ bom, cacheDirectory, packages = [], revision }) {
  if (!cacheDirectory) throw new Error("--cache is required");
  if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw new Error("--revision must be an immutable 40-character commit SHA");
  if (!revision) {
    const commit = JSON.parse(await boundedFetch("https://api.github.com/repos/conan-io/conan-center-index/commits/master"));
    revision = commit.sha;
    if (!/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("GitHub did not return an immutable recipe revision");
  }
  const wanted = new Set(packages);
  if ([...wanted].some((name) => !validName(name))) throw new Error("Invalid Conan package name");
  const requests = new Map();
  for (const component of bom.components || []) {
    const purl = parsePurlLoose(component.purl);
    if (purl?.type !== "conan" || purl.namespace || !validName(purl.name) || !component.version || purl.version !== component.version || wanted.size && !wanted.has(purl.name)) continue;
    if (!requests.has(purl.name)) requests.set(purl.name, new Set());
    requests.get(purl.name).add(component.version);
  }
  if (wanted.size && [...wanted].some((name) => !requests.has(name))) throw new Error("Requested package has no exact versioned Conan component in the BOM");
  if (requests.size > 256) throw new Error("More than 256 recipes requested; split the acquisition explicitly");
  mkdirSync(join(resolve(cacheDirectory), "conan"), { recursive: true });
  const results = [];
  for (const [name, versions] of requests) {
    try {
      const files = [];
      const acquire = async (path) => {
        const content = await boundedFetch(`https://raw.githubusercontent.com/conan-io/conan-center-index/${revision}/${path}`);
        const file = { path, sha256: sha256(content), content };
        files.push(file);
        return file;
      };
      const config = loadYaml((await acquire(`recipes/${name}/config.yml`)).content, { maxAliasCount: 0 });
      const folders = new Set();
      for (const version of versions) {
        const folder = config?.versions?.[version]?.folder;
        if (typeof folder !== "string" || !validName(folder)) throw new Error(`No recipe folder for ${name}@${version}`);
        folders.add(folder);
      }
      if (folders.size > 24) throw new Error(`Too many recipe folders for ${name}`);
      for (const folder of folders) {
        await acquire(`recipes/${name}/${folder}/conandata.yml`);
        await acquire(`recipes/${name}/${folder}/conanfile.py`);
      }
      const record = { schema: 1, repository, revision, package: name, versions: [...versions].sort(), files };
      const text = `${JSON.stringify(record, null, 2)}\n`;
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error(`Recipe cache record too large: ${name}`);
      const path = join(resolve(cacheDirectory), "conan", `${name}.json`);
      writeFileSync(path, text, { flag: "w" });
      results.push({ package: name, versions: record.versions, revision, path, sha256: sha256(text), files: files.map(({ path, sha256 }) => ({ path, sha256 })) });
    } catch (error) {
      results.push({ package: name, revision, error: error.message });
    }
  }
  return results;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const options = { packages: [] };
    for (let i = 0; i < args.length; i++) {
      const option = args[i];
      const value = args[++i];
      if (!value) throw new Error(`Missing value for ${option}`);
      if (option === "--package") options.packages.push(value);
      else if (option === "--cache") options.cacheDirectory = value;
      else if (option === "--revision") options.revision = value;
      else if (option === "--bom") options.bom = JSON.parse(readFileSync(value, "utf8"));
      else throw new Error(`Unknown option: ${option}`);
    }
    if (!options.bom) throw new Error("--bom is required (read-only exact package/version inventory)");
    const results = await acquireNativeCanonicalRecipes(options);
    for (const result of results) console.log(JSON.stringify(result));
    if (results.some((result) => result.error)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
