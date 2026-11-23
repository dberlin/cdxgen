import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { readRegularTextFile } from "../core/boundedFile.js";
import { pypiBomRef } from "../inventory/purl.js";
import { pythonDistNameVersion } from "./pythonLicenseMetadata.js";

const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
function compareNumeric(left, right) {
  if (!/^\d+(?:\.\d+)*$/.test(left) || !/^\d+(?:\.\d+)*$/.test(right)) return undefined;
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
function satisfies(version, clauses) {
  return clauses.split(",").every((clause) => {
    const match = clause.trim().match(/^(==|!=|>=|<=|>|<)\s*(\d+(?:\.\d+)*)$/);
    if (!match) return false;
    const comparison = compareNumeric(version, match[2]);
    if (comparison === undefined) return false;
    return ({ "==": comparison === 0, "!=": comparison !== 0, ">=": comparison >= 0,
      "<=": comparison <= 0, ">": comparison > 0, "<": comparison < 0 })[match[1]];
  });
}
function pythonVersion(site) {
  // Resolve the site's actual installation layout, not an arbitrary enclosing
  // project's config (which could contain extracted wheels or another venv).
  try { site = realpathSync(site); } catch { return undefined; }
  const pythonDirectory = basename(dirname(site)).match(/^python(\d+\.\d+)$/);
  let environment;
  if (pythonDirectory && ["lib", "lib64"].includes(basename(dirname(dirname(site))))) {
    environment = dirname(dirname(dirname(site)));
  } else if (basename(dirname(site)) === "Lib") {
    environment = dirname(dirname(site));
  } else {
    return undefined;
  }
  const config = readRegularTextFile(join(environment, "pyvenv.cfg"), 16384);
  const version = config?.match(/^version\s*=\s*(\d+\.\d+)(?:\.\d+)?\s*$/m)?.[1];
  if (pythonDirectory && pythonDirectory[1] !== version) return undefined;
  return version;
}

/**
 * Apply requirements only to the scanned installed environment. Unsupported
 * markers and universal wheel/source requirements remain unresolved. Proven
 * inactive placeholders become owner provenance rather than installed inventory.
 */
export function installedRequirementsResolver(metadataFiles) {
  const sites = new Map();
  const metadata = new Map();
  for (const file of metadataFiles) {
    const text = readRegularTextFile(file, 1024 * 1024);
    const identity = pythonDistNameVersion(text);
    metadata.set(file, text || "");
    if (!identity?.version) continue;
    const site = dirname(dirname(file));
    if (!["site-packages", "dist-packages"].includes(basename(site))) continue;
    const packages = sites.get(site) || new Map();
    const key = normalize(identity.name);
    const copies = packages.get(key) || [];
    copies.push({ ...identity, file });
    packages.set(key, copies);
    sites.set(site, packages);
  }
  return (parsed, ownerFile) => {
    const site = dirname(dirname(ownerFile));
    if (!["site-packages", "dist-packages"].includes(basename(site))) return;
    const packages = sites.get(site);
    const text = metadata.get(ownerFile) || "";
    const owner = pythonDistNameVersion(text);
    if (!owner?.version) return;
    const ownerRef = pypiBomRef(owner.name, owner.version);
    const requirements = text.split(/\r?\n\r?\n/, 1)[0].split(/\r?\n/).filter((line) => line.startsWith("Requires-Dist:")).map((line) => line.slice("Requires-Dist:".length).trim());
    const remap = new Map();
    const inactive = new Set();
    const provenance = [];
    const python = pythonVersion(site);
    const normalizeRequirement = (value) => value.replace(/\s+/g, "").replaceAll("'", '"').toLowerCase();
    for (const component of parsed.components) {
      const oldRef = component["bom-ref"];
      if (component.version || !oldRef?.startsWith("requires-dist:") || !component.purl?.startsWith("pkg:pypi/")) continue;
      const candidates = packages?.get(normalize(component.name)) || [];
      // Match the actual upstream requirement before interpreting its marker.
      const expected = new Set([
        oldRef.slice("requires-dist:".length),
        ...(component.properties || []).filter((p) => p.name.endsWith(":requires-dist")).map((p) => p.value),
      ].map(normalizeRequirement));
      const requirement = requirements.find((value) => expected.has(normalizeRequirement(value)));
      if (!requirement) continue;
      const [spec, marker, ...extra] = requirement.split(";");
      if (extra.length) continue;
      const match = spec.trim().match(/^([A-Za-z0-9_.-]+)\s*(.*)$/);
      if (!match || normalize(match[1]) !== normalize(component.name)) continue;
      if (marker) {
        const condition = marker.trim().match(/^python_version\s*(==|!=|>=|<=|>|<)\s*['"](\d+\.\d+)['"]$/);
        if (!condition || !python) continue;
        if (!satisfies(python, `${condition[1]}${condition[2]}`)) {
          // A separate component's edge is not this owner's conditional use.
          const usedElsewhere = (parsed.dependencies || []).some((dep) =>
            dep.ref !== parsed.rootRef && dep.ref !== ownerRef && dep.ref !== oldRef &&
            ["dependsOn", "provides"].some((key) => dep[key]?.includes(oldRef)));
          if (!usedElsewhere) {
            inactive.add(oldRef);
            provenance.push({
              name: "cdx:pypi:inactiveRequirement",
              value: JSON.stringify({ requirement, pythonVersion: python, metadata: ownerFile, component }),
            });
          }
          continue;
        }
      }
      if (candidates.length !== 1) continue;
      const installed = candidates[0];
      if (!satisfies(installed.version, match[2])) continue;
      const selected = requirement;
      component.version = installed.version;
      component.purl = pypiBomRef(installed.name, installed.version);
      component["bom-ref"] = component.purl;
      component.properties ||= [];
      component.properties.push(
        { name: "cdx:embeddedSbom:resolvedRequirement", value: selected },
        { name: "cdx:pypi:installedMetadata", value: installed.file },
      );
      remap.set(oldRef, component["bom-ref"]);
    }
    const removed = parsed.components.filter((component) => inactive.has(component["bom-ref"]));
    parsed.components = parsed.components.filter((component) => !inactive.has(component["bom-ref"]));
    if (provenance.length) {
      const existing = parsed.components.find((component) => component["bom-ref"] === ownerRef);
      if (existing) {
        existing.properties ||= [];
        existing.properties.push(...provenance);
      } else {
        parsed.components.push({ type: "library", name: owner.name, version: owner.version, purl: ownerRef, "bom-ref": ownerRef, properties: provenance });
      }
    }
    parsed.dependencies = (parsed.dependencies || []).filter((dependency) => !inactive.has(dependency.ref));
    for (const dependency of parsed.dependencies || []) {
      dependency.ref = remap.get(dependency.ref) || dependency.ref;
      for (const key of ["dependsOn", "provides"]) {
        if (dependency[key]) dependency[key] = [...new Set(dependency[key].filter((ref) => !inactive.has(ref)).map((ref) => remap.get(ref) || ref))];
      }
    }
    if (!removed.length) return;
    // Removing a conditional container must not delete nested inventory still
    // referenced by a retained dependency/provides edge or dependency row.
    const referenced = new Set(parsed.dependencies.flatMap((dependency) =>
      [dependency.ref, ...(dependency.dependsOn || []), ...(dependency.provides || [])]));
    const defined = new Set();
    const remember = (components) => {
      for (const component of components || []) {
        if (component["bom-ref"]) defined.add(component["bom-ref"]);
        remember(component.components);
      }
    };
    remember(parsed.components);
    const preserve = (components) => {
      for (const component of components || []) {
        const ref = component["bom-ref"];
        if (referenced.has(ref) && !defined.has(ref)) {
          parsed.components.push(component);
          remember([component]);
        } else {
          preserve(component.components);
        }
      }
    };
    for (const component of removed) preserve(component.components);
  };
}
