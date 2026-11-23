import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { readRegularTextFile } from "../core/boundedFile.js";
import { safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { isProjectToolingAllowed } from "../core/projectTooling.js";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_EXTENSION_BYTES = 64 * 1024 * 1024;
const validVersion = (value) => typeof value === "string" && /^\d+(?:\.\d+){1,3}(?:[-+._a-zA-Z0-9]*)$/.test(value) && value.length < 100;

function recordedFile(site, row) {
  // This adapter only accepts plain RECORD paths with SHA256 and exact sizes.
  // Quoted/foreign/traversing entries are unsupported, never guessed.
  const [path, hash, size, ...extra] = row.split(",");
  if (extra.length || !path || path.includes("\"") || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => [".", "..", ""].includes(part))) return undefined;
  if (!/^sha256=[A-Za-z0-9_-]+$/.test(hash || "") || !/^\d+$/.test(size || "")) return undefined;
  const file = resolve(site, path);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_EXTENSION_BYTES || stat.size !== Number(size) || realpathSync(file) !== file) return undefined;
    const actual = createHash("sha256").update(readFileSync(file)).digest("base64url");
    return hash === `sha256=${actual}` ? file : undefined;
  } catch { return undefined; }
}

/**
 * A single known native API adapter, not an arbitrary Python import runner.
 * Resolves a bundled zlib-ng license and extension from the same installed
 * distribution RECORD. Wheels, foreign sites, missing sandboxes and policy
 * denials remain unknown. Nothing is installed or written to the scanned tree.
 */
export function probePythonBundledNativeVersion(licenseFile, options = {}) {
  if (options.nativeVersionProbes !== true || !isProjectToolingAllowed(options) || process.platform !== "linux") return undefined;
  const license = resolve(licenseFile);
  // The adapter is deliberately tied to this bundled-library layout and API.
  const site = dirname(dirname(dirname(license)));
  if (!["site-packages", "dist-packages"].includes(basename(site)) || relative(site, license).split(sep).join("/") !== "zlib_ng/zlib-ng/LICENSE.md") return undefined;
  try { if (realpathSync(site) !== site) return undefined; } catch { return undefined; }
  let environment = site;
  for (let i = 0; i < 8 && !safeExistsSync(join(environment, "pyvenv.cfg")); i++) environment = dirname(environment);
  const config = readRegularTextFile(join(environment, "pyvenv.cfg"), 16384);
  if (!config) return undefined;
  let interpreter;
  let interpreterRoot;
  let pythonMinor;
  let runtimeLibrary;
  try {
    interpreter = realpathSync(join(environment, "bin", "python"));
    interpreterRoot = dirname(dirname(interpreter));
    const configured = config.match(/^executable\s*=\s*(.+)$/m)?.[1]?.trim();
    pythonMinor = config.match(/^version\s*=\s*(\d+\.\d+)(?:\.\d+)?\s*$/m)?.[1];
    runtimeLibrary = join(interpreterRoot, "lib");
    if (!configured || realpathSync(configured) !== interpreter || !pythonMinor ||
      !/^python\d+(?:\.\d+)?$/.test(basename(interpreter)) || interpreterRoot === "/" ||
      realpathSync(runtimeLibrary) !== runtimeLibrary ||
      !safeExistsSync(join(runtimeLibrary, `python${pythonMinor}`, "encodings", "__init__.py"))) return undefined;
  } catch { return undefined; }
  let owners;
  try {
    owners = readdirSync(site).filter((entry) => entry.endsWith(".dist-info")).filter((entry) => {
      const ownerDir = join(site, entry);
      if (!lstatSync(ownerDir).isDirectory() || realpathSync(ownerDir) !== ownerDir) return false;
      const text = readRegularTextFile(join(ownerDir, "METADATA"), MAX_RECORD_BYTES, site);
      return /^Name:\s*zlib[-_]ng\s*$/mi.test(text || "");
    });
  } catch { return undefined; }
  if (owners.length !== 1) return undefined;
  const metadata = join(site, owners[0], "METADATA");
  const record = join(site, owners[0], "RECORD");
  const rows = readRegularTextFile(record, MAX_RECORD_BYTES, site)?.split(/\r?\n/);
  if (!rows) return undefined;
  const licenseRows = rows.filter((row) => row.startsWith("zlib_ng/zlib-ng/LICENSE.md,"));
  const extensionRows = rows.filter((row) => /^zlib_ng\/zlib_ng\.[A-Za-z0-9_.-]+\.so,/.test(row));
  if (licenseRows.length !== 1 || extensionRows.length !== 1 || recordedFile(site, licenseRows[0]) !== license) return undefined;
  const extension = recordedFile(site, extensionRows[0]);
  if (!extension) return undefined;
  // Load only the recorded extension, without site.py, .pth, package __init__,
  // PYTHONPATH or user site packages. No project Python module is imported.
  const script = `import importlib.util
import json
import os
import socket
import sys
import resource

os.closerange(3, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
path = sys.argv[1]
spec = importlib.util.spec_from_file_location("zlib_ng", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
extra_fds = []
for fd in range(3, 256):
    try:
        os.fstat(fd)
        extra_fds.append(fd)
    except OSError:
        pass
print(json.dumps({
    "module": module.__file__,
    "readOnly": bool(os.statvfs(path).f_flag & os.ST_RDONLY),
    "pid": os.getpid(),
    "procAbsent": not os.path.exists("/proc"),
    "homeAbsent": not os.path.exists("/home"),
    "environmentKeys": sorted(os.environ),
    "extraFds": extra_fds,
    "interfaces": [name for _, name in socket.if_nameindex()],
    "compiled": module.ZLIBNG_VERSION,
    "runtime": module.ZLIBNG_RUNTIME_VERSION,
    "compatibilityCompiled": module.ZLIB_VERSION,
    "compatibilityRuntime": module.ZLIB_RUNTIME_VERSION,
}))`;
  const sandboxExtension = `/probe/${basename(extension)}`;
  const args = ["--die-with-parent", "--unshare-all", "--new-session", "--cap-drop", "ALL", "--clearenv"];
  for (const system of ["/usr", "/lib", "/lib64"]) if (safeExistsSync(system)) args.push("--ro-bind", system, system);
  // Do not mount the user's home or the environment. Relocate just Python's
  // executable/runtime library and hide any global site-packages directory.
  args.push("--dir", "/runtime/bin", "--ro-bind", interpreter, "/runtime/bin/python", "--ro-bind", runtimeLibrary, "/runtime/lib");
  const globalSite = `/runtime/lib/python${pythonMinor}/site-packages`;
  if (safeExistsSync(join(runtimeLibrary, `python${pythonMinor}`, "site-packages"))) args.push("--tmpfs", globalSite);
  args.push("--dir", "/probe", "--ro-bind", extension, sandboxExtension, "--dev", "/dev", "--tmpfs", "/tmp", "--setenv", "HOME", "/tmp", "--chdir", "/tmp", "/runtime/bin/python", "-I", "-S", "-B", "-c", script, sandboxExtension);
  const result = safeSpawnSync("/usr/bin/bwrap", args, { cwd: "/", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 10000, killSignal: "SIGKILL", maxBuffer: 16384, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  if (result.status !== 0 || result.error) return undefined;
  let fact;
  try { fact = JSON.parse(result.stdout); } catch { return undefined; }
  if (fact === null || typeof fact !== "object" || Array.isArray(fact)) return undefined;
  if (!validVersion(fact.compatibilityRuntime) || !validVersion(fact.compatibilityCompiled)) return undefined;
  if (fact.module !== sandboxExtension || fact.readOnly !== true || !validVersion(fact.runtime) || !validVersion(fact.compiled) || fact.runtime !== fact.compiled) return undefined;
  if (fact.pid !== 2 || fact.procAbsent !== true || fact.homeAbsent !== true ||
    !Array.isArray(fact.environmentKeys) || !fact.environmentKeys.every((key) => ["HOME", "PWD", "LC_CTYPE"].includes(key)) ||
    !Array.isArray(fact.extraFds) || fact.extraFds.length ||
    !Array.isArray(fact.interfaces) || fact.interfaces.some((name) => name !== "lo")) return undefined;
  return {
    version: fact.runtime,
    source: extension,
    properties: Object.entries({
      api: "zlib_ng.ZLIBNG_RUNTIME_VERSION", runtime: fact.runtime, compiled: fact.compiled,
      compatibilityRuntime: fact.compatibilityRuntime, compatibilityCompiled: fact.compatibilityCompiled,
      extension, metadata, record, readOnly: "true",
      pid: String(fact.pid), procAbsent: "true", homeAbsent: "true", environmentKeys: JSON.stringify(fact.environmentKeys),
      extraFds: JSON.stringify(fact.extraFds), interfaces: JSON.stringify(fact.interfaces),
    }).map(([key, value]) => ({ name: `cdx:nativeVersion:${key}`, value })),
  };
}
