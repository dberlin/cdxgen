import { dirname, join, parse, sep } from "node:path";

import { readRegularTextFile } from "../core/boundedFile.js";

const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
const MAX_METADATA_BYTES = 1024 * 1024;

/** Read identity headers, never the license snippet or a dist-info filename. */
export function pythonDistNameVersion(text) {
  let name;
  let version;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) break;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === "name" && name === undefined) name = value;
    if (key === "version" && version === undefined) version = value;
  }
  return name ? { name, version } : null;
}

/**
 * Resolve a license's actual installed/vendored Python distribution. A wheel's
 * licenses/src/... copy points back to that distribution's vendor manifest;
 * the outer wheel's version is not the bundled library's version.
 */
export function pythonLicenseIdentity(file) {
  const parts = file.split(sep);
  const vendorAt = parts.lastIndexOf("_vendor");
  if (vendorAt >= 0 && vendorAt + 1 < parts.length - 1) {
    let vendorRoot = parts.slice(0, vendorAt + 1).join(sep);
    const distAt = parts.findIndex((part) => part.endsWith(".dist-info"));
    if (distAt >= 0 && distAt < vendorAt) {
      const srcAt = parts.indexOf("src", distAt + 1);
      if (srcAt < 0 || srcAt > vendorAt) return undefined;
      vendorRoot = join(parts.slice(0, distAt).join(sep), ...parts.slice(srcAt + 1, vendorAt + 1));
    }
    const packageName = normalizeName(parts[vendorAt + 1]);
    const source = join(vendorRoot, "vendor.txt");
    const pins = readRegularTextFile(source, MAX_METADATA_BYTES);
    if (pins) {
      for (const line of pins.split(/\r?\n/)) {
        const match = line.trim().match(/^([A-Za-z0-9_.-]+)==([^\s;#]+)(?:\s|;|#|$)/);
        if (match && normalizeName(match[1]) === packageName) {
          return { name: packageName, version: match[2], source };
        }
      }
    }
  }
  let dir = dirname(file);
  while (dir !== parse(dir).root) {
    if (dir.endsWith(".dist-info")) {
      // An inner vendor directory without a pin must not inherit pip's release.
      if (vendorAt >= 0 && !parts[vendorAt + 1]?.endsWith(".dist-info")) return undefined;
      const source = join(dir, "METADATA");
      const metadata = pythonDistNameVersion(readRegularTextFile(source, MAX_METADATA_BYTES));
      if (metadata?.name && metadata.version) {
        return { name: normalizeName(metadata.name), version: metadata.version, source };
      }
      return undefined;
    }
    dir = dirname(dir);
  }
  return undefined;
}
