import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { canParallelizeGitMetadata, getSourceCommandEpoch, isImmutableSourcePath, safeExistsSync } from "../core/fs.js";
import { registerRunReset } from "../core/runState.js";
import { parseGitRemoteUrl } from "../parsers/gitmodules.js";
import { execGitMetadata, execGitMetadataBatch } from "./envcontext.js";

const revisions = new Map();
let commandEpoch = getSourceCommandEpoch();
let generation = 0;
registerRunReset("sourceRevision:revisions", () => {
  revisions.clear();
  generation++;
});

/** Find an actual checkout boundary without inventing a dependency identity. */
export function sourceRootOf(manifest) {
  let root = dirname(resolve(manifest));
  while (!safeExistsSync(resolve(root, ".git"))) {
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
  return root;
}

function gitOutput(root, args) {
  return successfulOutput(execGitMetadata(root, args));
}

function successfulOutput(result) {
  if (result.error || result.status !== 0 || result.signal) return undefined;
  return result.stdout?.toString() ?? "";
}

function nulPaths(output) {
  if (output === undefined || (output && !output.endsWith("\0"))) {
    return undefined;
  }
  const paths = output ? output.slice(0, -1).split("\0") : [];
  return paths.some((path) => !path) ? undefined : paths;
}

function hasSafeFilters(root) {
  const result = execGitMetadata(root, [
    "config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$",
  ]);
  if (result.error || result.signal) return false;
  const output = result.stdout?.toString() ?? "";
  if (result.status === 1) return output === "";
  if (result.status !== 0) return false;
  const entries = nulPaths(output);
  return entries !== undefined && entries.length > 0 && entries.every((entry) => {
    const newline = entry.indexOf("\n");
    return newline > 0 && !entry.slice(newline + 1).trim();
  });
}

function immutableGitInputs(root, version) {
  if (!isImmutableSourcePath(root)) return undefined;
  try {
    const worktree = gitOutput(root, ["rev-parse", "--show-toplevel"])?.trim();
    if (!worktree || !isImmutableSourcePath(realpathSync(worktree))) return undefined;
    // A split index depends on separate shared-index files. Keep the existing
    // fresh-observation behavior rather than retaining an incomplete snapshot.
    const sharedIndex = gitOutput(root, ["rev-parse", "--shared-index-path"]);
    if (sharedIndex === undefined || sharedIndex.trim()) return undefined;
    const index = gitOutput(root, ["rev-parse", "--git-path", "index"])?.trim();
    const config = gitOutput(root, ["config", "--null", "--list"]);
    if (!index || config === undefined) return undefined;
    const indexPath = resolve(root, index);
    const indexHash = createHash("sha256").update(readFileSync(indexPath)).digest("hex");
    return { version, worktree: realpathSync(worktree), indexPath, indexHash, config };
  } catch {
    return undefined;
  }
}

function immutableGitInputsUnchanged(root, revision) {
  const previous = revision?.immutableInputs;
  if (!previous || !isImmutableSourcePath(root)) return false;
  // Config includes, linked-worktree refs and alternate index/worktree inputs
  // can live outside the asserted source root. Reobserve all of them before
  // reusing any diff, including approvals inherited through submodules.
  const version = gitOutput(root, ["rev-parse", "--verify", "HEAD"])?.trim();
  const current = immutableGitInputs(root, version);
  return Boolean(current &&
    current.version === previous.version &&
    current.worktree === previous.worktree &&
    current.indexPath === previous.indexPath &&
    current.indexHash === previous.indexHash &&
    current.config === previous.config);
}

function observeRevision(root) {
  // Diff/status may invoke clean/process filters even with --no-ext-diff and
  // --no-textconv. Do not execute them merely to infer a fallback revision.
  if (!hasSafeFilters(root)) return undefined;
  const version = gitOutput(root, ["rev-parse", "--verify", "HEAD"])?.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(version || "")) return undefined;
  const entries = nulPaths(gitOutput(root, ["ls-files", "--stage", "-z"]));
  if (!entries) return undefined;
  const tracked = new Set();
  const gitlinks = new Set();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab === -1) return undefined;
    const fields = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (fields.length !== 3 || !/^[0-3]$/.test(fields[2]) || !path) return undefined;
    tracked.add(path);
    if (fields[0] === "160000") gitlinks.add(path);
  }
  const origin = execGitMetadata(root, ["config", "--get", "remote.origin.url"]);
  // Git exits 1 when an optional config key does not exist.
  if (origin.error || origin.signal || ![0, 1].includes(origin.status)) return undefined;
  const remote = origin.status === 0 && parseGitRemoteUrl(origin.stdout?.toString().trim());
  const repository = remote ? `${remote.baseUrl}/${remote.name}` : undefined;
  return { version, repository, tracked, gitlinks, dirtySubtrees: new Map(), immutableInputs: immutableGitInputs(root, version) };
}

function revisionFor(root) {
  if (!revisions.has(root)) revisions.set(root, observeRevision(root));
  return revisions.get(root);
}

function hasSafeSubmodules(root, revision, subtree, batchEligibility, seen = new Set()) {
  if (batchEligibility && (!revision.immutableInputs || !isImmutableSourcePath(root) ||
    !isImmutableSourcePath(revision.immutableInputs.worktree))) batchEligibility.immutable = false;
  try {
    const identity = realpathSync(root);
    if (seen.has(identity)) return false;
    seen.add(identity);
  } catch {
    return false;
  }
  for (const path of revision.gitlinks) {
    if (subtree && path !== subtree && !path.startsWith(`${subtree}/`)) continue;
    const childRoot = resolve(root, path);
    // An unpopulated submodule cannot run a child Git status/filter.
    if (!safeExistsSync(resolve(childRoot, ".git"))) continue;
    const child = revisionFor(childRoot);
    if (!child || !hasSafeSubmodules(childRoot, child, "", batchEligibility, seen)) return false;
  }
  return true;
}

function subtreeDiffArgs(subtree) {
  return [
    "--literal-pathspecs", "--no-optional-locks", "diff", "--name-only", "--no-renames",
    "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-z", "HEAD", "--", subtree || ".",
  ];
}

function cleanFromOutput(output) {
  const changed = nulPaths(output);
  return changed === undefined ? undefined : changed.length === 0;
}

function isSubtreeClean(root, revision, subtree) {
  if (revision.dirtySubtrees.has(subtree)) return revision.dirtySubtrees.get(subtree);
  let clean;
  // A scoped diff can ask Git status to inspect populated submodules, including
  // their own locally configured filters. Guard those before starting the diff.
  if (hasSafeSubmodules(root, revision, subtree)) {
    clean = cleanFromOutput(gitOutput(root, subtreeDiffArgs(subtree)));
  }
  revision.dirtySubtrees.set(subtree, clean);
  return clean;
}

function synchronizeRevisionEpoch() {
  const epoch = getSourceCommandEpoch();
  if (epoch !== commandEpoch) {
    // Preserve observations only when every checkout's source and effective
    // Git inputs are unchanged. A changed child can dirty a cached parent.
    for (const [root, revision] of revisions) {
      if (!immutableGitInputsUnchanged(root, revision)) {
        revisions.clear();
        break;
      }
    }
    commandEpoch = epoch;
  }
}

function revisionCandidate(manifest) {
  const file = resolve(manifest);
  const root = sourceRootOf(file);
  if (!root) return undefined;
  const revision = revisionFor(root);
  if (!revision) return undefined;
  const trackedPath = relative(root, file).split(sep).join("/");
  if (!revision.tracked.has(trackedPath)) return undefined;
  const subpath = relative(root, dirname(file)).split(sep).join("/");
  return { root, revision, subpath, trackedPath };
}

function revisionResult(candidate) {
  if (!candidate) return undefined;
  const { root, revision, subpath, trackedPath } = candidate;
  if (!revision.dirtySubtrees.get(subpath)) return undefined;
  return { version: revision.version, repository: revision.repository, root, subpath, manifest: trackedPath };
}

/**
 * Identify the source revision of an actual tracked manifest, never of a
 * dependency merely mentioned by it. Each repository has one observed HEAD,
 * origin and tracked-path snapshot per BOM generation; each requested subtree's
 * cleanliness is observed lazily. resetRunState clears both; source-writing
 * helpers invalidate mutable roots only. Keep tracked inputs and Git config
 * fixed during analysis; external edits are observed on the next generation.
 * No source contents, finished BOMs, or cross-generation state are persisted.
 */
export function sourceRevisionOf(manifest) {
  synchronizeRevisionEpoch();
  const candidate = revisionCandidate(manifest);
  if (candidate) isSubtreeClean(candidate.root, candidate.revision, candidate.subpath);
  return revisionResult(candidate);
}

/**
 * Resolve actual, already requested manifests in input order. Only the
 * independent scoped diffs are batched: repository observations, tracked
 * membership, filter checks, and recursive submodule approvals remain in the
 * parent. Never widen a pathspec to amortize queries or inspect other scopes.
 */
export async function sourceRevisionsOf(manifests) {
  if (manifests.length < 2 || !canParallelizeGitMetadata()) return manifests.map(sourceRevisionOf);
  synchronizeRevisionEpoch();
  const observedGeneration = generation;
  const observedEpoch = commandEpoch;
  const candidates = [];
  const scheduled = [];
  const pending = new Map();
  const flush = async () => {
    const results = await execGitMetadataBatch(scheduled.map(({ root, subpath }) => [root, subtreeDiffArgs(subpath)]));
    // Do not install observations across a concurrent source-writing helper
    // or a generation reset. Return to the original fresh serial path.
    if (observedEpoch !== getSourceCommandEpoch() || observedGeneration !== generation) return false;
    for (const [index, { revision, subpath }] of scheduled.entries()) {
      revision.dirtySubtrees.set(subpath, cleanFromOutput(successfulOutput(results[index])));
    }
    scheduled.length = 0;
    pending.clear();
    return true;
  };
  for (const manifest of manifests) {
    const candidate = revisionCandidate(manifest);
    candidates.push(candidate);
    if (!candidate) continue;
    const { root, revision, subpath } = candidate;
    if (revision.dirtySubtrees.has(subpath) || pending.get(revision)?.has(subpath)) continue;
    const eligibility = { immutable: Boolean(revision.immutableInputs) };
    if (!hasSafeSubmodules(root, revision, subpath, eligibility)) {
      revision.dirtySubtrees.set(subpath, undefined);
      continue;
    }
    if (!eligibility.immutable) {
      // A mutable or incompletely observed checkout is deliberately serial.
      // Drain previously requested immutable work before running this diff.
      if (scheduled.length && !(await flush())) return manifests.map(sourceRevisionOf);
      revision.dirtySubtrees.set(subpath, cleanFromOutput(gitOutput(root, subtreeDiffArgs(subpath))));
      continue;
    }
    if (!pending.has(revision)) pending.set(revision, new Set());
    pending.get(revision).add(subpath);
    scheduled.push(candidate);
  }
  if (scheduled.length && !(await flush())) return manifests.map(sourceRevisionOf);
  return candidates.map(revisionResult);
}
