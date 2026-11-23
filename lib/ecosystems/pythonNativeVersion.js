import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { openRegularFile, readRegularTextFile } from "../core/boundedFile.js";
import { safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { isProjectToolingAllowed } from "../core/projectTooling.js";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_EXTENSION_BYTES = 64 * 1024 * 1024;
const ELF_SYMBOL_BYTES = 24;
const VERSION_SYMBOL = "zng_vstring";
const VERSION_SECTION = ".rodata";
const ELF_VERSION_SYMBOL = Buffer.from(`${VERSION_SYMBOL}\0`);
const ELF_VERSION_SECTION = Buffer.from(`${VERSION_SECTION}\0`);
const validVersion = (value) => typeof value === "string" && /^\d+(?:\.\d+){1,3}(?:[-+._a-zA-Z0-9]*)$/.test(value) && value.length < 100;

function recordedFile(site, row) {
  // This adapter only accepts plain RECORD paths with SHA256 and exact sizes.
  // Quoted/foreign/traversing entries are unsupported, never guessed.
  const [path, hash, size, ...extra] = row.split(",");
  if (extra.length || !path || path.includes("\"") || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => [".", "..", ""].includes(part))) return undefined;
  if (!/^sha256=[A-Za-z0-9_-]+$/.test(hash || "") || !/^\d+$/.test(size || "")) return undefined;
  const file = resolve(site, path);
  let opened;
  try {
    if (realpathSync(file) !== file) return undefined;
    opened = openRegularFile(file, site);
    if (!opened || opened.size > MAX_EXTENSION_BYTES || opened.size !== Number(size)) return undefined;
    const bytes = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(opened.fd, bytes, total, bytes.length - total, total);
      if (count <= 0) return undefined;
      total += count;
    }
    if (fstatSync(opened.fd).size !== bytes.length) return undefined;
    const actual = createHash("sha256").update(bytes).digest("base64url");
    return hash === `sha256=${actual}` ? { file, bytes } : undefined;
  } catch {
    return undefined;
  } finally {
    if (opened) {
      try { closeSync(opened.fd); } catch { /* already closed */ }
    }
  }
}

// ELF64 pointers are unsigned 64-bit values; reject unrepresentable ranges
// before using them as Buffer indices or combining them with other fields.
function fits(offset, size, limit) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size) &&
    size > 0 && offset >= 0 && offset <= limit - size;
}

function overlaps(a, aSize, b, bSize) {
  return aSize > 0 && bSize > 0 && a < b + bSize && b < a + aSize;
}

function zlibNgElfVersion(bytes) {
  // Support only normal sectioned little-endian ELF64 shared objects. This
  // adapter does not interpret instructions, relocations, or arbitrary strings.
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 ||
    bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 ||
    bytes.readUInt16LE(16) !== 3 || !bytes.readUInt16LE(18) ||
    bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64 ||
    bytes.readUInt16LE(54) !== 56 || bytes.readUInt16LE(58) !== 64) return undefined;
  const u64 = (at) => Number(bytes.readBigUInt64LE(at));
  const phoff = u64(32);
  const phnum = bytes.readUInt16LE(56);
  const shoff = u64(40);
  const shnum = bytes.readUInt16LE(60);
  const shstrndx = bytes.readUInt16LE(62);
  if (phoff < 64 || shoff < 64 || phnum > 128 || shnum > 4096 ||
    !shstrndx || shstrndx >= shnum || !fits(phoff, phnum * 56, bytes.length) ||
    !fits(shoff, shnum * 64, bytes.length) || overlaps(phoff, phnum * 56, shoff, shnum * 64)) return undefined;

  const section = (index) => {
    const at = shoff + index * 64;
    return {
      name: bytes.readUInt32LE(at), type: bytes.readUInt32LE(at + 4),
      flags: u64(at + 8), address: u64(at + 16),
      offset: u64(at + 24), size: u64(at + 32),
      link: bytes.readUInt32LE(at + 40), entrySize: u64(at + 56),
    };
  };
  const inFile = ({ offset, size }) => fits(offset, size, bytes.length);
  const named = (strings, index, name) =>
    fits(index, name.length, strings.size) &&
    bytes.compare(name, 0, name.length, strings.offset + index, strings.offset + index + name.length) === 0;
  let symbols;
  let symbolIndex;
  for (let i = 1; i < shnum; i++) {
    if (bytes.readUInt32LE(shoff + i * 64 + 4) !== 11) continue; // SHT_DYNSYM
    if (symbols) return undefined;
    symbols = section(i);
    symbolIndex = i;
  }
  if (!symbols || symbols.flags !== 2 || !symbols.link || symbols.link >= shnum ||
    symbols.entrySize !== ELF_SYMBOL_BYTES || symbols.size % ELF_SYMBOL_BYTES ||
    symbols.size / ELF_SYMBOL_BYTES > 65536 || !inFile(symbols)) return undefined;
  const strings = section(symbols.link);
  const sectionNames = section(shstrndx);
  if (strings.type !== 3 || strings.flags !== 2 || !inFile(strings) ||
    sectionNames.type !== 3 || !inFile(sectionNames) ||
    bytes[strings.offset] !== 0 || bytes[strings.offset + strings.size - 1] !== 0 ||
    bytes[sectionNames.offset] !== 0 || bytes[sectionNames.offset + sectionNames.size - 1] !== 0) return undefined;

  let symbol;
  for (let at = symbols.offset; at < symbols.offset + symbols.size; at += ELF_SYMBOL_BYTES) {
    const name = bytes.readUInt32LE(at);
    if (name >= strings.size) return undefined;
    if (!named(strings, name, ELF_VERSION_SYMBOL)) continue;
    if (symbol !== undefined) return undefined;
    symbol = at;
  }
  // STB_GLOBAL / STT_OBJECT, STV_DEFAULT, defined in a real section.
  if (symbol === undefined || bytes[symbol + 4] !== 0x11 || bytes[symbol + 5] !== 0) return undefined;
  const objectIndex = bytes.readUInt16LE(symbol + 6);
  if (!objectIndex || objectIndex >= shnum) return undefined;
  const data = section(objectIndex);
  if (data.type !== 1 || data.flags !== 2 || !inFile(data) || // SHT_PROGBITS, SHF_ALLOC only
    !named(sectionNames, data.name, ELF_VERSION_SECTION)) return undefined;
  const address = u64(symbol + 8);
  const size = u64(symbol + 16);
  if (!Number.isSafeInteger(address) || !Number.isSafeInteger(data.address) ||
    size > 128 || !fits(address - data.address, size, data.size)) return undefined;

  // The evidence sections must own their bytes, not alias other sections or
  // the ELF headers. Ignore NOBITS sections, which have no file data.
  const evidenceSections = [[symbolIndex, symbols], [symbols.link, strings], [objectIndex, data]];
  for (const [, { offset, size: span }] of evidenceSections) {
    if (offset < 64 || overlaps(offset, span, phoff, phnum * 56) ||
      overlaps(offset, span, shoff, shnum * 64)) return undefined;
  }
  for (let i = 1; i < shnum; i++) {
    const at = shoff + i * 64;
    if (bytes.readUInt32LE(at + 4) === 8) continue;
    const offset = u64(at + 24);
    const span = u64(at + 32);
    if (span && !fits(offset, span, bytes.length)) return undefined;
    if (evidenceSections.some(([index, sec]) =>
      i !== index && overlaps(offset, span, sec.offset, sec.size))) return undefined;
  }

  const loads = [];
  let dynamic;
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * 56;
    const type = bytes.readUInt32LE(at);
    if (type === 3) return undefined; // PT_INTERP: not a library.
    if (type !== 1 && type !== 2) continue; // PT_LOAD, PT_DYNAMIC
    const segment = {
      flags: bytes.readUInt32LE(at + 4),
      offset: u64(at + 8), address: u64(at + 16),
      size: u64(at + 32), memSize: u64(at + 40),
    };
    if (segment.size > segment.memSize ||
      (segment.size && !inFile(segment)) ||
      !fits(segment.address, segment.memSize, Number.MAX_SAFE_INTEGER)) return undefined;
    if (type === 1) loads.push(segment);
    else if (dynamic) return undefined;
    else dynamic = segment;
  }
  const mapped = (region, readOnly) => {
    if (!fits(region.address, region.size, Number.MAX_SAFE_INTEGER)) return false;
    let load;
    for (const candidate of loads) {
      if (!overlaps(region.address, region.size, candidate.address, candidate.memSize) &&
        !overlaps(region.offset, region.size, candidate.offset, candidate.size)) continue;
      if (load) return false;
      load = candidate;
    }
    return !!load && (readOnly ? load.flags === 4 : (load.flags & 4) !== 0) &&
      fits(region.offset - load.offset, region.size, load.size) &&
      region.address - load.address === region.offset - load.offset;
  };
  if (!dynamic || dynamic.size % 16 || dynamic.size / 16 > 4096 || !mapped(dynamic, false) ||
    !mapped(data, true) || !mapped(symbols, true) || !mapped(strings, true)) return undefined;

  // Cross-check that these are the dynamic object's linked symbol/string
  // tables, not unrelated sections that merely resemble them.
  const links = new Map([[5, strings.address], [6, symbols.address], [10, strings.size], [11, ELF_SYMBOL_BYTES]]);
  const dynamicEnd = dynamic.offset + dynamic.size;
  for (let at = dynamic.offset; at < dynamicEnd; at += 16) {
    const tag = u64(at);
    if (tag === 0) {
      if (links.size) return undefined;
      const start = data.offset + (address - data.address);
      if (bytes[start + size - 1] !== 0) return undefined;
      const version = /^ zlib-ng (\d+\.\d+\.\d+)\0+$/.exec(bytes.toString("latin1", start, start + size))?.[1];
      return validVersion(version) ? version : undefined;
    }
    if (tag === 22 || (tag === 30 && (bytes.readUInt32LE(at + 8) & 4))) return undefined; // DT_TEXTREL / DF_TEXTREL
    if (tag === 5 || tag === 6 || tag === 10 || tag === 11) {
      if (links.get(tag) !== u64(at + 8)) return undefined;
      links.delete(tag);
    }
  }
  return undefined;
}

function versionFact(version, extension, metadata, record, facts) {
  return {
    version,
    source: extension,
    properties: Object.entries({ ...facts, extension, metadata, record })
      .map(([key, value]) => ({ name: `cdx:nativeVersion:${key}`, value })),
  };
}

/**
 * A single known native adapter, not an arbitrary Python import runner.
 * Read the version object from the RECORD-checked extension when possible.
 * Only the fallback can load code, and it needs the existing sandbox.
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
  const configured = config?.match(/^executable\s*=\s*(.+)$/m)?.[1]?.trim();
  const pythonMinor = config?.match(/^version\s*=\s*(\d+\.\d+)(?:\.\d+)?\s*$/m)?.[1];
  if (!configured || !pythonMinor) return undefined;
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
  if (licenseRows.length !== 1 || extensionRows.length !== 1 || recordedFile(site, licenseRows[0])?.file !== license) return undefined;
  const recorded = recordedFile(site, extensionRows[0]);
  if (!recorded) return undefined;
  const { file: extension, bytes } = recorded;
  const version = zlibNgElfVersion(bytes);
  if (version) return versionFact(version, extension, metadata, record, {
    method: "elf-symbol", symbol: VERSION_SYMBOL, section: VERSION_SECTION,
  });

  let interpreter;
  let runtimeLibrary;
  try {
    interpreter = realpathSync(join(environment, "bin", "python"));
    const interpreterRoot = dirname(dirname(interpreter));
    runtimeLibrary = join(interpreterRoot, "lib");
    if (realpathSync(configured) !== interpreter ||
      !/^python\d+(?:\.\d+)?$/.test(basename(interpreter)) || interpreterRoot === "/" ||
      realpathSync(runtimeLibrary) !== runtimeLibrary ||
      !safeExistsSync(join(runtimeLibrary, `python${pythonMinor}`, "encodings", "__init__.py"))) return undefined;
  } catch { return undefined; }
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
  return versionFact(fact.runtime, extension, metadata, record, {
    method: "sandboxed-runtime-api",
    api: "zlib_ng.ZLIBNG_RUNTIME_VERSION", runtime: fact.runtime, compiled: fact.compiled,
    compatibilityRuntime: fact.compatibilityRuntime, compatibilityCompiled: fact.compatibilityCompiled,
    readOnly: "true",
    pid: String(fact.pid), procAbsent: "true", homeAbsent: "true", environmentKeys: JSON.stringify(fact.environmentKeys),
    extraFds: JSON.stringify(fact.extraFds), interfaces: JSON.stringify(fact.interfaces),
  });
}
