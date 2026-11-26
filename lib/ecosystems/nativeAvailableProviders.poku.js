import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { resolveNativeAvailableProviders } from "./nativeAvailableProviders.js";
import { nativePackageFileExports, nativeProviderPlatformAccepts } from "./nativeExternalMetadata.js";
import { collectNativeProviders, resolveNativeRequirements } from "./nativeProviderIndex.js";
import { parseCmakeLikeFile } from "./parsers-misc.js";

const requirement = (name, constraints = "", command = "dependency") => ({
  requestedName: name, constraints, command, role: "software",
  file: "meson.build", line: 3, ordinal: 1, arguments: [`'${name}'`],
  conditions: [], providerCandidates: [],
});
const component = (records) => ({ name: "cdx-fixture-provider", "bom-ref": "requirement", purl: "pkg:generic/cdx-fixture-provider", properties: records.map((r) => ({ name: "cdx:build:requirement", value: JSON.stringify(r) })) });
const enabled = { introspect: true, nativeVersionProbes: true };
function tarFixture(entries) {
  const parts = [];
  for (const [member, text] of Array.isArray(entries) ? entries : Object.entries(entries)) {
    const content = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(member); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write("0", 156);
    header.write(`${header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function zipFixture(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [member, text, mode = 0o100644] of entries) {
    const name = Buffer.from(member);
    const content = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(content.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((mode * 0x10000) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function assertUnselectedOwner(result, request, source, name, version, compatibility) {
  const owner = result.pkgList.find((entry) => entry.name === name && entry.version === version);
  assert.ok(owner, "genuine owner availability does not wait for an interface predicate");
  assert.ok(owner.properties.some((entry) => entry.name === "cdx:native:selection" && entry.value === "available-not-selected"));
  const unresolved = result.pkgList.flatMap((entry) => entry.version ? [] : entry.properties || []).filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value));
  assert.ok(unresolved.some((entry) => entry.requestedName === request.requestedName && entry.constraints === request.constraints));
  const resolved = resolveNativeRequirements([request], collectNativeProviders([], { scanRoot: source, availableProviders: result.pkgList }));
  assert.equal(resolved.bindings.length, 0);
  assert.ok(resolved.unresolved[0].candidates.some((entry) => entry.ref === owner["bom-ref"] && entry.compatibility === compatibility));
}

describe("available native environment providers", () => {
  it("observes approved Python distribution metadata without lending the helper release or executing site code", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-python-distribution-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const site = join(source, "approved-site"); mkdirSync(site);
      const distribution = (directory, name, version, entries) => {
        const path = join(site, directory); mkdirSync(path);
        writeFileSync(join(path, "METADATA"), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n\n`);
        if (entries) writeFileSync(join(path, "entry_points.txt"), entries);
      };
      distribution("pytest-8.4.2.dist-info", "pytest", "8.4.2", "[console_scripts]\npytest = pytest:console_main\n");
      distribution("pytest_cmake-0.13.0.dist-info", "pytest-cmake", "0.13.0");
      writeFileSync(join(site, "sitecustomize.py"), "raise RuntimeError('must not execute approved site')");
      process.env.PATH = "";
      const req = { ...requirement("Pytest", "99.0", "find_package"), arguments: ["Pytest", "99.0"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Pytest" }], [], { ...enabled, nativeProbeSite: site });
      const owner = result.pkgList.find((entry) => entry.name === "pytest" && entry.version === "8.4.2");
      assert.ok(owner, "a genuine distribution stays available despite the incompatible request");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(exports.some((entry) => entry.kind === "tool" && entry.name === "pytest" && entry.source === join(site, "pytest-8.4.2.dist-info/entry_points.txt")));
      assert.ok(!result.pkgList.some((entry) => entry.name === "Pytest" && entry.version === "0.13.0"));
      assert.ok(result.pkgList.some((entry) => entry.name === "Pytest" && !entry.version));
      const index = collectNativeProviders([], { scanRoot: source, availableProviders: result.pkgList });
      assert.ok(index.providers.some((entry) => entry.version === "8.4.2"), "observation receipts survive the normal index");
      const forged = JSON.parse(JSON.stringify(owner));
      assert.ok(!collectNativeProviders([], { scanRoot: source, availableProviders: [forged] }).providers.some((entry) => entry.version === "8.4.2"), "JSON replay cannot mint installed observations");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("proves approved console-script material only from an intact distribution RECORD without executing it", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-console-script-record-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const site = join(source, ".venv/lib/python3.14/site-packages");
      const distribution = join(site, "pytest-8.4.2.dist-info"); mkdirSync(distribution, { recursive: true });
      const bin = join(source, ".venv/bin"); mkdirSync(bin);
      const script = "#!/usr/bin/python3\nfrom pytest import console_main\nraise SystemExit(console_main())\n";
      const path = join(bin, "pytest"); writeFileSync(path, script); chmodSync(path, 0o755);
      writeFileSync(join(distribution, "METADATA"), "Name: pytest\nVersion: 8.4.2\n\n");
      writeFileSync(join(distribution, "entry_points.txt"), "[console_scripts]\npytest = pytest:console_main\n");
      writeFileSync(join(distribution, "RECORD"), `../../../bin/pytest,sha256=${createHash("sha256").update(script).digest("base64url")},${Buffer.byteLength(script)}\n`);
      process.env.PATH = "";
      const req = { ...requirement("Pytest", "", "find_package"), arguments: ["Pytest"] };
      const exportsFor = () => {
        const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Pytest" }], [], { ...enabled, nativeProbeSite: site });
        const owner = result.pkgList.find((entry) => entry.name === "pytest" && entry.version === "8.4.2");
        return JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      };
      assert.equal(exportsFor().find((entry) => entry.name === "pytest")?.executablePath, path);
      writeFileSync(path, "tampered console script");
      assert.equal(exportsFor().find((entry) => entry.name === "pytest")?.executableUnknown, true);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps observed Python owners for development and incompatible legacy requests without inventing missing material", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-python-development-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const include = join(root, "include"); mkdirSync(include);
      writeFileSync(join(include, "Python.h"), "#ifdef Py_LIMITED_API\n#endif\n#include \"patchlevel.h\"\n");
      writeFileSync(join(include, "pyconfig.h"), "#define SIZEOF_VOID_P 8\n/* #undef Py_DEBUG */\n#define Py_GIL_DISABLED 1\n");
      writeFileSync(join(include, "patchlevel.h"), '#define PY_VERSION "3.14.8"\n');
      const library = join(root, "libpython3.14.so"); writeFileSync(library, "observed development material");
      const details = { version: "3.14.8", include, platinclude: include, libdir: root, library: "libpython3.14.so", soabi: "cpython-314t-x86_64-linux-gnu", pointerSize: 8, debug: 0 };
      const path = join(bin, "python3");
      writeFileSync(path, `#!/bin/sh\ncase "$*" in *sysconfig*) printf '%s\\n' '${JSON.stringify(details)}';; *) printf '%s\\n' '3.14.8';; esac\n`);
      chmodSync(path, 0o755); process.env.PATH = bin;
      const req = { ...requirement("Python3", "", "find_package"), arguments: ["Python3", "COMPONENTS", "Development", "NumPy"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Python3" }], [], enabled);
      const owner = result.pkgList.find((entry) => entry.version === "3.14.8");
      assert.ok(owner, "development requests must retain the actual Python owner");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(exports.some((entry) => entry.kind === "capability" && entry.name === "python-development-embed"));
      assert.ok(!exports.some((entry) => entry.name === "numpy"), "interpreter sysconfig does not establish NumPy");
      assert.ok(result.pkgList.some((entry) => !entry.version), "unproved NumPy keeps the requirement unresolved");
      assert.ok(!exports.some((entry) => entry.name === "python-development-sabi" && entry.materialUnknown !== true), "free-threaded Python does not establish the stable ABI");
      details.soabi = "cpython-314-x86_64-linux-gnu";
      writeFileSync(join(include, "pyconfig.h"), "#define SIZEOF_VOID_P 8\n/* #undef Py_DEBUG */\n/* #undef Py_GIL_DISABLED */\n");
      writeFileSync(path, `#!/bin/sh\ncase "$*" in *sysconfig*) printf '%s\\n' '${JSON.stringify(details)}';; *) printf '%s\\n' '3.14.8';; esac\n`);
      const conventional = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Python3" }], [], enabled);
      const conventionalOwner = conventional.pkgList.find((entry) => entry.version === "3.14.8");
      const conventionalExports = JSON.parse(conventionalOwner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(conventionalExports.some((entry) => entry.name === "python-development-sabi" && entry.materialUnknown !== true), "coherent conventional Python stable-ABI material remains available");
      for (const soabi of ["cpython-314t-x86_64-linux-gnu", "cpython-314d-x86_64-linux-gnu", "cpython-3145-x86_64-linux-gnu"]) {
        details.soabi = soabi;
        writeFileSync(path, `#!/bin/sh\ncase "$*" in *sysconfig*) printf '%s\\n' '${JSON.stringify(details)}';; *) printf '%s\\n' '3.14.8';; esac\n`);
        const contradictory = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Python3" }], [], enabled);
        const actualOwner = contradictory.pkgList.find((entry) => entry.version === "3.14.8");
        const actualExports = JSON.parse(actualOwner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
        assert.ok(!actualExports.some((entry) => entry.name === "python-development-module" && entry.materialUnknown !== true), "SOABI version/debug/free-threaded flags must agree with actual interpreter and header ABI evidence");
      }
      const legacy = { ...requirement("PythonInterp", "3.6 EXACT", "find_package"), arguments: ["PythonInterp", "3.6", "EXACT"] };
      const incompatible = resolveNativeAvailableProviders(source, [{ ...component([legacy]), name: "PythonInterp" }], [], enabled);
      assert.ok(incompatible.pkgList.some((entry) => entry.version === "3.14.8"));
      assert.ok(incompatible.pkgList.some((entry) => !entry.version));
      const python2 = { ...requirement("Python2", "", "find_package"), arguments: ["Python2"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([python2]), name: "Python2" }], [], enabled).observedProviders, 0);
      writeFileSync(join(include, "patchlevel.h"), '#define PY_VERSION "3.13.2"\n');
      const mismatched = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Python3" }], [], enabled);
      const mismatchedOwner = mismatched.pkgList.find((entry) => entry.version === "3.14.8");
      const mismatchedExports = JSON.parse(mismatchedOwner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(!mismatchedExports.some((entry) => entry.name.startsWith("python-development-")), "mismatched headers never authorize development capabilities");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains typed cached stub material and verified member bytes without treating inventory as contents", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-cached-material-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const header = "#define OBSERVED_API_VERSION 17\n";
      writeFileSync(join(root, "driver.h"), header);
      const snapshot = JSON.stringify({ schema: 1, name: "driver-sdk", versionKind: "release", version: "12.4.99",
        files: ["/sdk/include/driver.h", "/sdk/lib/stubs/libdriver.so"],
        evidence: [{ path: "driver.h", member: "/sdk/include/driver.h", sha256: createHash("sha256").update(header).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), snapshot);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      const req = { ...requirement("Driver", "", "find_package"), arguments: ["Driver"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Driver" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const owner = result.pkgList.find((entry) => entry.name === "driver-sdk");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      const exp = exports.find((entry) => entry.kind === "header-file" && entry.name === "driver.h");
      assert.equal(exp.source, join(root, "driver.h"));
      assert.deepEqual(exp.headerDefines, { OBSERVED_API_VERSION: "17" });
      assert.equal(exp.materialSha256, createHash("sha256").update(header).digest("hex"));
      assert.ok(exports.some((entry) => entry.kind === "library" && entry.name === "driver" && entry.material === "stub"));
      assert.ok(!exports.find((entry) => entry.kind === "library").content, "a filename inventory is not library bytes");
      writeFileSync(join(root, "driver.h"), "tampered");
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Driver" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses Sphinx and Cython tool-owned releases and ocamlfind-mediated compiler evidence", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-language-tools-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const stdlib = join(root, "ocaml"); mkdirSync(stdlib);
      const script = (name, body) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
      script("sphinx-build2", "printf '%s\\n' 'sphinx-build 8.2.3'");
      script("cython3", "printf '%s\\n' 'Cython version 3.0.12'");
      script("ocamlfind", `case "$*" in 'ocamlc -version') printf '%s\\n' '5.3.0';; 'ocamlc -where') printf '%s\\n' '${stdlib}';; *) exit 2;; esac`);
      process.env.PATH = bin;
      for (const [name, version, binary] of [["Sphinx", "8.2.3", "sphinx-build2"], ["Cython", "3.0.12", "cython3"], ["OCaml", "5.3.0", "ocamlfind"]]) {
        const req = { ...requirement(name, "", "find_package"), arguments: [name] };
        const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name }], [], enabled);
        const owner = result.pkgList.find((entry) => entry.version === version);
        assert.ok(owner, `${name} uses its own observed output`);
        const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
        assert.ok(exports.some((entry) => entry.kind === "tool" && entry.name === binary));
      }
      script("cython3", "printf '%s\\n' 'Cython version 0.29.37' >&2");
      const cythonRequest = { ...requirement("Cython", "", "find_package"), arguments: ["Cython"] };
      const legacyCython = resolveNativeAvailableProviders(source, [{ ...component([cythonRequest]), name: "Cython" }], [], enabled);
      assert.ok(legacyCython.pkgList.some((entry) => entry.version === "0.29.37"), "legacy Cython version output on stderr retains its genuine owner");
      rmSync(join(bin, "ocamlfind"));
      script("ocamlc", "printf '%s\\n' '5.3.0'");
      const req = { ...requirement("OCaml", "", "find_package"), arguments: ["OCaml"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name: "OCaml" }], [], enabled).observedProviders, 0, "ocamlc alone is insufficient");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an inventory-only Cython executable owner available without asserting finder satisfaction", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-cython-owner-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const owner = JSON.stringify({ name: "cython", version: "3.2.1", release: "1", files: ["/usr/bin/cython"] });
      writeFileSync(join(root, "cython.json"), owner);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{
        metadata: { path: "cython.json", format: "rpm-json", sha256: createHash("sha256").update(owner).digest("hex") },
      }] }));
      const req = { ...requirement("Cython", "", "find_package"), arguments: ["Cython", "QUIET"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Cython" }], [], { nativeProviderMetadata: manifest });
      assertUnselectedOwner(result, req, source, "cython", "3.2.1-1", "unknown");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("makes genuine compiler owners available for scoped compile capabilities without claiming compile success", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-compiler-capability-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(join(source, "cmake"), { recursive: true });
      writeFileSync(join(source, "cmake/FindFeature.cmake"), 'check_cxx_source_compiles("#include <filesystem>\\nint main() {}" FEATURE_OK)\nfind_package_handle_standard_args(Feature DEFAULT_MSG FEATURE_OK)\n');
      const bin = join(root, "bin"); mkdirSync(bin);
      writeFileSync(join(bin, "c++"), "#!/bin/sh\ntest \"$1\" = \"--version\" || exit 2\nprintf '%s\\n' 'c++ (GCC) 15.2.1'\n");
      chmodSync(join(bin, "c++"), 0o755); process.env.PATH = bin;
      const req = { ...requirement("Feature", "", "find_package"), file: "CMakeLists.txt", arguments: ["Feature"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Feature" }], [], enabled);
      const owner = result.pkgList.find((entry) => entry.version === "15.2.1");
      assert.ok(owner);
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(exports.some((entry) => entry.kind === "capability" && entry.name === "cxx-compiler"));
      assert.ok(result.pkgList.some((entry) => !entry.version), "compiler presence is not a successful source compile");
      rmSync(join(bin, "c++"));
      writeFileSync(join(bin, "clang"), "#!/bin/sh\nprintf '%s\\n' 'clang version 17.0.6'\n"); chmodSync(join(bin, "clang"), 0o755);
      symlinkSync("clang", join(bin, "c++")); symlinkSync("clang", join(bin, "cc"));
      const aliases = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Feature" }], [], enabled);
      const aliasExports = aliases.pkgList.filter((entry) => entry.version === "17.0.6").flatMap((entry) =>
        JSON.parse(entry.properties.find((property) => property.name === "cdx:native:providerExports").value));
      assert.ok(aliasExports.some((entry) => entry.name === "cxx-compiler") && aliasExports.some((entry) => entry.name === "c-compiler"), "shared real compiler binaries retain both language capabilities");
      assert.ok(aliasExports.some((entry) => entry.kind === "tool" && entry.name === "c++") && aliasExports.some((entry) => entry.kind === "tool" && entry.name === "cc"), "observed executable aliases survive canonical-path deduplication");
      rmSync(join(bin, "c++")); rmSync(join(bin, "cc")); rmSync(join(bin, "clang"));
      const dispatcher = join(bin, "compiler-dispatch");
      writeFileSync(dispatcher, '#!/bin/sh\ncase "${0##*/}" in c++) printf "%s\\n" "clang version 18.0.1";; cc) printf "%s\\n" "clang version 19.0.2";; *) exit 2;; esac\n');
      chmodSync(dispatcher, 0o755);
      symlinkSync(dispatcher, join(bin, "c++")); symlinkSync(dispatcher, join(bin, "cc"));
      const dispatched = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Feature" }], [], enabled);
      for (const [version, capability, name] of [["18.0.1", "cxx-compiler", "c++"], ["19.0.2", "c-compiler", "cc"]]) {
        const observed = dispatched.pkgList.find((entry) => entry.version === version);
        assert.ok(observed, "multicall compiler aliases must execute through their approved lookup paths");
        const evidence = JSON.parse(observed.properties.find((property) => property.name === "cdx:native:providerEvidence").value);
        assert.equal(evidence.path, join(bin, name));
        assert.equal(evidence.realPath, dispatcher);
        assert.ok(evidence.exports.some((entry) => entry.name === capability));
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("observes installed documentation and site wrapper package owners without executing arbitrary wrappers", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-site-tool-owner-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const sentinel = join(root, "executed");
      for (const name of ["latex", "tau_cxx.sh", "upcxx-meta"]) {
        writeFileSync(join(bin, name), `#!/bin/sh\nprintf executed > '${sentinel}'\nexit 9\n`);
        chmodSync(join(bin, name), 0o755);
      }
      writeFileSync(join(bin, "rpm"), "#!/bin/sh\ntest \"$1\" = \"-qf\" || exit 2\nprintf 'site-tools\\t0\\t2025.4\\t2.site\\tx86_64\\n'\n");
      chmodSync(join(bin, "rpm"), 0o755); process.env.PATH = bin;
      for (const name of ["LATEX", "TAU", "UPCXX"]) {
        const req = { ...requirement(name, "", "find_package"), arguments: [name] };
        const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name }], [], enabled);
        assert.ok(result.pkgList.some((entry) => entry.name === "site-tools" && entry.version === "2025.4-2.site"), "real package owner is available independently from full module contract");
        assert.ok(result.pkgList.some((entry) => !entry.version), "wrapper package ownership does not prove complete site/TeX predicates");
      }
      writeFileSync(join(bin, "mawk"), `#!/bin/sh\nprintf executed > '${sentinel}'\nexit 9\n`); chmodSync(join(bin, "mawk"), 0o755);
      symlinkSync("mawk", join(bin, "awk"));
      mkdirSync(join(source, "cmake"));
      const module = join(source, "cmake/FindHarness.cmake"); writeFileSync(module, "find_program(HARNESS_PROGRAM NAMES awk)\n");
      const harness = { ...requirement("Harness", "", "find_package"), arguments: ["Harness"] };
      const observedAlias = resolveNativeAvailableProviders(source, [{ ...component([harness]), name: "Harness" }], [], { ...enabled, nativeSourceManifests: [module] });
      const aliasExports = observedAlias.pkgList.filter((entry) => entry.version).flatMap((entry) =>
        JSON.parse(entry.properties.find((property) => property.name === "cdx:native:providerExports").value));
      assert.ok(aliasExports.some((entry) => entry.kind === "tool" && entry.name === "awk"), "an actual awk lookup retains its alias even when the package-owned realpath is mawk");
      assert.throws(() => readFileSync(sentinel), "no wrapper was executed");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers actual installed header and library owners demanded by local Find modules from the existing manifest inventory", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-find-material-owner-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(join(source, "cmake"), { recursive: true });
      const include = join(root, "vendor/headers"); mkdirSync(include, { recursive: true });
      const header = join(include, "threadlike.h"); writeFileSync(header, "#define THREADLIKE_ABI 3\n");
      const multiarch = join(root, "include/x86_64-linux-gnu"); mkdirSync(join(multiarch, "sys"), { recursive: true });
      const types = join(multiarch, "sys/types.h"); writeFileSync(types, "#define TYPES_ABI 2\n");
      const library = join(root, "libthreadlike.so.1"); writeFileSync(library, "runtime material");
      const module = join(source, "cmake/FindThreadlike.cmake");
      writeFileSync(module, `find_path(THREADLIKE_INCLUDE_DIR NAMES threadlike.h HINTS "${include}")\nfind_path(TYPES_INCLUDE_DIR NAMES sys/types.h HINTS "${multiarch}")\nfind_library(THREADLIKE_LIBRARY NAMES threadlike)\nfind_package_handle_standard_args(Threadlike REQUIRED_VARS THREADLIKE_INCLUDE_DIR THREADLIKE_LIBRARY)\n`);
      const bin = join(root, "bin"); mkdirSync(bin);
      writeFileSync(join(bin, "rpm"), "#!/bin/sh\ntest \"$1\" = \"-qf\" || exit 2\nprintf 'runtime-owner\\t0\\t2.43\\t9.local\\tx86_64\\n'\n");
      writeFileSync(join(bin, "ldconfig"), `#!/bin/sh\nprintf '%s\\n' 'libthreadlike.so.1 (libc6,x86-64) => ${library}'\n`);
      chmodSync(join(bin, "rpm"), 0o755); chmodSync(join(bin, "ldconfig"), 0o755); process.env.PATH = bin;
      const req = { ...requirement("Threadlike", "", "find_package"), arguments: ["Threadlike"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Threadlike" }], [], { ...enabled, nativeSourceManifests: [module] });
      const exports = result.pkgList.filter((entry) => entry.version).flatMap((entry) => JSON.parse(entry.properties.find((property) => property.name === "cdx:native:providerExports").value));
      assert.ok(exports.some((entry) => entry.kind === "header-file" && entry.name === "threadlike.h" && entry.source === header));
      assert.ok(exports.some((entry) => entry.kind === "library" && entry.name === "threadlike" && entry.source === library));
      assert.ok(exports.some((entry) => entry.kind === "header-file" && entry.name === "sys/types.h" && entry.source === types), "multiarch roots retain the header identity relative to the observed search root");
      assert.ok(result.pkgList.filter((entry) => entry.version).every((entry) => entry.name === "runtime-owner" && entry.version === "2.43-9.local"));
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters every scoped Find owner by definite platform conflicts while retaining unknown-condition alternatives", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-find-owner-platform-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(join(source, "cmake"), { recursive: true });
      const include = join(root, "include"); mkdirSync(include);
      writeFileSync(join(include, "scoped.h"), "#define SCOPED_ABI 1\n");
      const library = join(root, "libscoped.so.1"); writeFileSync(library, "actual scoped library fixture");
      const module = join(source, "cmake/FindScoped.cmake");
      writeFileSync(module, `check_cxx_source_compiles("int main() {}" SCOPED_COMPILES)\nfind_program(SCOPED_TOOL NAMES scoped-installed scoped-cached)\nfind_path(SCOPED_HEADER NAMES scoped.h HINTS "${include}")\nfind_library(SCOPED_LIBRARY NAMES scoped)\n`);
      const bin = join(root, "bin"); mkdirSync(bin);
      const program = (name, body) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
      program("scoped-installed", "exit 9");
      program("c++", "test \"$1\" = --version || exit 2\nprintf '%s\\n' 'c++ (GCC) 16.1.1'");
      program("rpm", "test \"$1\" = -qf || exit 2\nprintf 'scoped-installed-owner\\t0\\t3.2\\t1.local\\tx86_64\\n'");
      program("ldconfig", `printf '%s\\n' 'libscoped.so.1 (libc6,x86-64) => ${library}'`);
      process.env.PATH = bin;
      const metadata = JSON.stringify({ name: "scoped-cached-owner", version: "5.4", release: "2.local", files: ["/opt/scoped/bin/scoped-cached"] });
      writeFileSync(join(root, "cached.json"), metadata);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ platform: process.platform,
        metadata: { path: "cached.json", format: "rpm-json", sha256: createHash("sha256").update(metadata).digest("hex") } }] }));
      const req = { ...requirement("Scoped", "", "find_package"), arguments: ["Scoped"] };
      const resolve = (conditions) => resolveNativeAvailableProviders(source, [
        { ...component([{ ...req, conditions }]), name: "Scoped" },
      ], [], { ...enabled, nativeSourceManifests: [module], nativeProviderMetadata: manifest });
      const windows = resolve(["if(WIN32)"]);
      assert.equal(windows.observedProviders, 0, "Find-derived compiler/program/header/library and cached program owners cannot bypass definite platform conflicts");
      const unknown = resolve(["if(UNKNOWN_BUILD_OPTION)"]);
      assert.ok(unknown.pkgList.some((entry) => entry.name === "scoped-installed-owner" && entry.version === "3.2-1.local"));
      assert.ok(unknown.pkgList.some((entry) => entry.name === "scoped-cached-owner" && entry.version === "5.4-2.local"));
      assert.ok(unknown.pkgList.some((entry) => entry.version === "16.1.1"));
      assert.ok(unknown.pkgList.some((entry) => !entry.version), "unknown source predicates and compile results remain on the original occurrence");
      for (const conditions of [
        [["if(WIN32)"], ["if(UNKNOWN_BUILD_OPTION)"]],
        [["if(UNKNOWN_BUILD_OPTION)"], ["if(WIN32)"]],
      ]) {
        const mixed = resolveNativeAvailableProviders(source, [{ ...component(conditions.map((conditions, ordinal) =>
          ({ ...req, conditions, ordinal }))), name: "Scoped" }], [], {
          ...enabled, nativeSourceManifests: [module], nativeProviderMetadata: manifest,
        });
        assert.ok(mixed.pkgList.some((entry) => entry.name === "scoped-cached-owner" && entry.version === "5.4-2.local"),
          "an incompatible occurrence cannot suppress cached program availability for a compatible unknown occurrence");
        assert.ok(mixed.pkgList.some((entry) => entry.name === "scoped-installed-owner" && entry.version === "3.2-1.local"));
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers exact compiler-root static library owners independently of tool releases and source-local paths", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-compiler-library-owner-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const libraryRoot = join(root, "compiler/lib"); mkdirSync(libraryRoot, { recursive: true });
      const sourceLibraryRoot = join(source, "compiler"); mkdirSync(sourceLibraryRoot);
      for (const name of ["gcov", "stdc++fs"]) writeFileSync(join(libraryRoot, `lib${name}.a`), "actual static archive fixture");
      writeFileSync(join(sourceLibraryRoot, "libforged.a"), "untrusted source material");
      const bin = join(root, "bin"); mkdirSync(bin);
      const program = (name, body) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
      program("compiler-dispatch", `test "\${0##*/}" = gcc || exit 2\ncase "$1" in -print-search-dirs) printf '%s\\n' 'libraries: =${libraryRoot}:${sourceLibraryRoot}:relative';; --version) printf '%s\\n' 'gcc (local) 16.1.1';; *) exit 2;; esac`);
      symlinkSync("compiler-dispatch", join(bin, "gcc"));
      program("gcov", "printf '%s\\n' 'gcov (local) 99.1.0'");
      program("rpm", "test \"$1\" = \"-qf\" || exit 2\nprintf 'compiler-runtime-owner\\t0\\t16.1.1\\t3.local\\tx86_64\\n'");
      process.env.PATH = bin;
      const requests = ["gcov", "stdc++fs", "forged"].map((name) => ({
        ...component([{ ...requirement(name, "", "find_library"), arguments: [`${name}_LIBRARY`, "NAMES", name] }]),
        name, "bom-ref": `request-${name}`,
      }));
      const result = resolveNativeAvailableProviders(source, requests, [], enabled);
      const owner = result.pkgList.find((entry) => entry.name === "compiler-runtime-owner" && entry.version === "16.1.1-3.local");
      assert.ok(owner, "an exact installed static archive supplies its real package owner");
      const exports = result.pkgList.filter((entry) => entry.name === "compiler-runtime-owner").flatMap((entry) =>
        JSON.parse(entry.properties.find((property) => property.name === "cdx:native:providerExports").value));
      for (const name of ["gcov", "stdc++fs"]) {
        const entry = exports.find((entry) => entry.kind === "library" && entry.name === name);
        assert.equal(entry?.source, join(libraryRoot, `lib${name}.a`));
        assert.equal(entry?.material, "static");
        assert.equal(entry?.compilerSearch?.path, join(bin, "gcc"));
        assert.equal(entry?.compilerSearch?.realPath, join(bin, "compiler-dispatch"));
        assert.equal(entry?.materialUnknown, true, "host compiler search material is not proof of the original selected toolchain");
      }
      assert.ok(!exports.some((entry) => entry.name === "forged"));
      assert.ok(!result.pkgList.some((entry) => entry.version === "99.1.0"), "gcov executable release cannot satisfy archive discovery");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers authenticated installed CMake module contracts and demanded owners without lending the CMake release", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-installed-cmake-module-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const cmakeRoot = join(root, "installation/share/cmake"); mkdirSync(join(cmakeRoot, "Modules"), { recursive: true });
      const include = join(root, "vendor/headers"); mkdirSync(include, { recursive: true });
      writeFileSync(join(include, "iconv.h"), "#define REAL_ICONV_INTERFACE 1\n");
      const library = join(root, "libiconv.so.1"); writeFileSync(library, "real installed material fixture");
      const module = join(cmakeRoot, "Modules/FindIconv.cmake");
      const text = `find_path(Iconv_INCLUDE_DIR NAMES iconv.h HINTS "${include}")\nfind_library(Iconv_LIBRARY NAMES iconv)\nfind_package_handle_standard_args(Iconv REQUIRED_VARS Iconv_INCLUDE_DIR Iconv_LIBRARY)\n`;
      writeFileSync(module, text);
      const bin = join(root, "bin"); mkdirSync(bin);
      const cmake = join(bin, "cmake");
      const program = (name, body) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
      const workLog = join(root, "cmake-work-directories");
      const reportRoot = (path, version = "4.4.5") => program("cmake", `case "$1" in --version) printf '%s\\n' 'cmake version 4.4.5';; -P) test -f "$2" || exit 2; printf '%s\\n' '-- CMAKE_ROOT "${path}"' '-- CMAKE_VERSION "${version}"'; printf '%s\\n' "$PWD" >> '${workLog}'; printf owned > "$PWD/owned-marker";; *) exit 2;; esac`);
      reportRoot(cmakeRoot);
      program("rpm", "test \"$1\" = \"-qf\" || exit 2\nprintf 'iconv-owner\\t0\\t1.17.0\\t2.local\\tx86_64\\n'");
      program("ldconfig", `printf '%s\\n' 'libiconv.so.1 (libc6,x86-64) => ${library}'`);
      process.env.PATH = bin;
      const req = { ...requirement("Iconv", "", "find_package"), arguments: ["Iconv"] };
      const resolve = (extra = {}) => resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Iconv" }], [], { ...enabled, nativeSourceManifests: [], ...extra });
      const result = resolve();
      const cmakeOwner = result.pkgList.find((entry) => entry.name === "CMake" && entry.version === "4.4.5");
      assert.ok(cmakeOwner, "approved real CMake supplies module provenance, not the dependency release");
      const exports = JSON.parse(cmakeOwner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      const contract = exports.find((entry) => entry.kind === "capability" && entry.name === "cmake-find-module" && entry.moduleName === "Iconv");
      assert.equal(contract?.file, module);
      assert.equal(contract?.root, cmakeRoot);
      assert.equal(contract?.toolPath, cmake);
      assert.equal(contract?.sha256, createHash("sha256").update(text).digest("hex"));
      assert.ok(contract?.toolReportSha256);
      assert.ok(contract?.toolReportScriptSha256);
      assert.ok(result.pkgList.some((entry) => entry.name === "iconv-owner" && entry.version === "1.17.0-2.local"), "the observed standard-module contract drives the existing installed-material observers");
      assert.ok(!result.pkgList.some((entry) => entry.name === "Iconv" && entry.version === "4.4.5"));
      const repeated = resolve().pkgList.find((entry) => entry.name === "CMake" && entry.version === "4.4.5");
      assert.equal(repeated["bom-ref"], cmakeOwner["bom-ref"], "private CMake work directories do not destabilize authenticated provider identities");
      for (const directory of readFileSync(workLog, "utf8").trim().split("\n")) {
        assert.ok(directory !== tmpdir() && !directory.startsWith(`${source}/`), "the fixed tool-only script runs in a private out-of-tree working directory");
        assert.throws(() => readFileSync(join(directory, "owned-marker")), "owned CMake probe files are cleaned after the observation");
      }
      program("git", "printf '%s\\n' 'git version 2.43.1'");
      program("python3", "printf '%s\\n' '3.14.8'");
      const originalNow = Date.now;
      let cacheInterpretationStarted = false;
      try {
        Date.now = () => originalNow() + (cacheInterpretationStarted ? 60001 : 0);
        const delayedMetadata = { ...enabled, nativeSourceManifests: [], get nativeProviderMetadata() {
          cacheInterpretationStarted = true; return [];
        } };
        const gitRequest = { ...requirement("Git", "", "find_package"), arguments: ["Git"] };
        const pythonRequest = { ...requirement("Python3", "", "find_package"), arguments: ["Python3"] };
        const delayed = resolveNativeAvailableProviders(source, [
          { ...component([req]), name: "Iconv" }, { ...component([gitRequest]), name: "Git", "bom-ref": "git-request" },
          { ...component([pythonRequest]), name: "Python3", "bom-ref": "python-request" },
        ], [], delayedMetadata);
        assert.ok(delayed.pkgList.some((entry) => entry.name === "Git" && entry.version === "2.43.1"), "cache interpretation cannot consume the existing Git observation window");
        assert.ok(delayed.pkgList.some((entry) => entry.name === "python3" && entry.version === "3.14.8"), "cache interpretation cannot consume the existing Python observation window");
        assert.ok(delayed.pkgList.some((entry) => entry.name === "iconv-owner" && entry.version === "1.17.0-2.local"), "Find-derived host material is observed within the same preserved window, not after cache interpretation");
      } finally { Date.now = originalNow; }
      reportRoot(cmakeRoot, "4.4.6");
      assert.ok(!resolve().pkgList.some((entry) => entry.properties?.some((property) =>
        property.name === "cdx:native:providerExports" && JSON.parse(property.value).some((entry) => entry.name === "cmake-find-module"))),
      "the fixed report must agree with the observed tool release");
      reportRoot(source);
      const sourceRoot = resolve();
      assert.ok(!sourceRoot.pkgList.some((entry) => entry.properties?.some((property) =>
        property.name === "cdx:native:providerExports" && JSON.parse(property.value).some((entry) => entry.name === "cmake-find-module"))));
      reportRoot(cmakeRoot);
      rmSync(module); writeFileSync(join(root, "outside.cmake"), text); symlinkSync(join(root, "outside.cmake"), module);
      const escaped = resolve();
      assert.ok(!escaped.pkgList.some((entry) => entry.properties?.some((property) =>
        property.name === "cdx:native:providerExports" && JSON.parse(property.value).some((entry) => entry.name === "cmake-find-module"))), "a module symlink outside the observed CMake root is not trusted");
      process.env.PATH = "";
      const injected = resolve({ nativeBuiltinFindModules: [module] });
      assert.ok(!injected.pkgList.some((entry) => entry.properties?.some((property) =>
        property.name === "cdx:native:providerExports" && JSON.parse(property.value).some((entry) => entry.name === "cmake-find-module"))), "caller-supplied file paths cannot mint a module observation");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes a verified Meson-only cached source owner before index import without inventing transformed library aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-meson-source-owner-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const descriptor = (path, text, format) => {
        mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text);
        return { path, sha256: createHash("sha256").update(text).digest("hex"), ...(format ? { format } : {}) };
      };
      const rootMeson = "\ufeffproject('libva', 'c', version : '2.24.1')\nsubdir('va')\n";
      const childMeson = "if host_machine.system() == 'windows'\n  shared_library('va_win32', 'va.c', install : true)\nendif\n";
      const archiveBytes = tarFixture({ "libva-2.24.1/meson.build": rootMeson, "libva-2.24.1/va/meson.build": childMeson });
      const archiveSha512 = createHash("sha512").update(archiveBytes).digest("hex");
      descriptor("source-artifacts/libva.tar", archiveBytes);
      const metadata = descriptor("vcpkg.json", JSON.stringify({ name: "libva", version: "2.24.1" }), "vcpkg-json");
      const recipe = descriptor("portfile.cmake", `vcpkg_from_github(REPO intel/libva REF 2.24.1 SHA512 ${archiveSha512})\n`);
      const base = "source-metadata/archive/libva-2.24.1";
      const supplemental = [
        descriptor(`${base}/meson.build`, rootMeson),
        descriptor(`${base}/va/meson.build`, childMeson),
        descriptor("source-metadata/archive/archive-manifest.json", JSON.stringify({ archivePath: "source-artifacts/libva.tar", sourceSha512: archiveSha512,
          acquisitionUrls: ["https://example.invalid/actual-source.tar"], members: ["libva-2.24.1/meson.build", "libva-2.24.1/va/meson.build"] })),
      ];
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata, recipe, supplemental, registryRevision: "a".repeat(40) }] }));
      const req = { ...requirement("va_win32", "", "find_library"), arguments: ["VA_LIBRARY", "NAMES", "va_win32", "rocm_sysdeps_va_win32", "HINTS", "${UNKNOWN_STAGING_ROOT}"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "va_win32" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const owner = result.pkgList.find((entry) => entry.name === "libva" && entry.version === "2.24.1");
      assert.ok(owner, "source ownership must survive the availability stage before index-only logic can use it");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(exports.some((entry) => entry.kind === "library" && entry.name === "va_win32" && entry.materialUnknown === true));
      assert.equal(exports.find((entry) => entry.name === "va_win32")?.sourceArchive?.sha256, createHash("sha256").update(archiveBytes).digest("hex"), "source transformations require exact archive identity, not a matching directory or release");
      assert.ok(!exports.some((entry) => entry.name === "rocm_sysdeps_va_win32"), "an unexecuted source transformation is not an alias declaration");
      assert.ok(result.pkgList.some((entry) => entry.name === "va_win32" && !entry.version), "source owner availability is not staged binary satisfaction");
      const strippedRoot = rootMeson.slice(1);
      writeFileSync(join(root, supplemental[0].path), strippedRoot);
      const strippedSupplemental = [{ ...supplemental[0], sha256: createHash("sha256").update(strippedRoot).digest("hex") }, ...supplemental.slice(1)];
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata, recipe, supplemental: strippedSupplemental, registryRevision: "a".repeat(40) }] }));
      const stripped = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "va_win32" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const strippedOwner = stripped.pkgList.find((entry) => entry.name === "libva" && entry.version === "2.24.1");
      const strippedExports = JSON.parse(strippedOwner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(!strippedExports.some((entry) => entry.sourceArchive), "BOM-stripped supplemental text is not the exact archived source member");
      writeFileSync(join(root, "source-artifacts/libva.tar"), "tampered source archive");
      const tampered = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "va_win32" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const retained = tampered.pkgList.find((entry) => entry.name === "libva" && entry.version === "2.24.1");
      const retainedExports = JSON.parse(retained.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(!retainedExports.some((entry) => entry.sourceArchive), "a modified payload cannot authenticate a wrap/source transform identity");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("automatically reads authenticated local archive members from existing inventory receipts", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-archive-material-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const member = "sdk/include/actual.h"; const content = "#define ACTUAL_VERSION 7\n";
      const header = Buffer.alloc(512);
      header.write(member); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
      header.write(`${Buffer.byteLength(content).toString(8).padStart(11, "0")}\0`, 124);
      header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write("0", 156);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
      const archive = Buffer.concat([header, Buffer.from(content), Buffer.alloc(512 - Buffer.byteLength(content)), Buffer.alloc(1024)]);
      writeFileSync(join(root, "payload.tar"), archive);
      const inventory = JSON.stringify({ schema: 1, artifact: "payload.tar", sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length, files: [member] });
      writeFileSync(join(root, "inventory.json"), inventory);
      const snapshot = JSON.stringify({ schema: 1, name: "actual-sdk", versionKind: "release", version: "7.2", files: [member],
        evidence: [{ path: "inventory.json", sha256: createHash("sha256").update(inventory).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), snapshot);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      const req = { ...requirement("Actual", "", "find_package"), arguments: ["Actual"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Actual" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const owner = result.pkgList.find((entry) => entry.version === "7.2");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.deepEqual(exports.find((entry) => entry.name === "actual.h")?.headerDefines, { ACTUAL_VERSION: "7" });
      assert.equal(exports.find((entry) => entry.name === "actual.h")?.materialSha256, createHash("sha256").update(content).digest("hex"));
      assert.equal(exports.find((entry) => entry.name === "actual.h")?.source, `${join(root, "payload.tar")}#${member}`);
      const developmentMember = "sdk/include/development.h";
      const development = tarFixture({ [developmentMember]: "#define DEVELOPMENT_VERSION 8\n" });
      writeFileSync(join(root, "development.tar"), development);
      writeFileSync(join(root, "development.tar.files.json"), JSON.stringify({ artifact: "development.tar", sha256: createHash("sha256").update(development).digest("hex"), size: development.length, files: [developmentMember] }));
      const release = JSON.stringify({ "local-sibling": { version: "8.3", "linux-x86_64": {
        runtime: { relative_path: "payload.tar", sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length },
        development: { relative_path: "development.tar", sha256: createHash("sha256").update(development).digest("hex"), size: development.length },
      } } });
      writeFileSync(join(root, "release.json"), release);
      writeFileSync(join(root, "payload.tar.files.json"), inventory);
      const seed = JSON.stringify({ schema: 1, name: "seed-sdk", versionKind: "release", version: "1.0", files: ["/include/seed.h"],
        evidence: [{ path: "release.json", sha256: createHash("sha256").update(release).digest("hex") }] });
      writeFileSync(join(root, "seed.json"), seed);
      const siblingManifest = join(root, "sibling-providers.json");
      writeFileSync(siblingManifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "seed.json", format: "provider-snapshot", sha256: createHash("sha256").update(seed).digest("hex") } }] }));
      const discovered = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Actual" }], [], { ...enabled, nativeProviderMetadata: siblingManifest });
      assert.ok(discovered.pkgList.some((entry) => entry.name === "local-sibling" && entry.version === "8.3"), "normal loading discovers locally cached sibling payloads from authenticated release evidence");
      const siblingExports = discovered.pkgList.filter((entry) => entry.name === "local-sibling" && entry.version === "8.3").flatMap((entry) =>
        JSON.parse(entry.properties.find((property) => property.name === "cdx:native:providerExports").value));
      assert.ok(siblingExports.some((entry) => entry.name === "actual.h") && siblingExports.some((entry) => entry.name === "development.h"), "same-owner runtime and development assets retain both authenticated export sets");
      archive[512] = 0; writeFileSync(join(root, "payload.tar"), archive);
      const tampered = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Actual" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const retained = tampered.pkgList.find((entry) => entry.version === "7.2");
      const retainedExports = JSON.parse(retained.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(!retainedExports.some((entry) => entry.materialSha256), "tampered payload cannot lend material content; authenticated owner inventory survives");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps tar member byte boundaries intact and does not authenticate concatenated duplicate member contents", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-tar-boundaries-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const original = "\ufeff#define FIRST_VERSION 1\n// café\n";
      const second = "#define SECOND_VERSION 2\n";
      const entries = [["sdk/include/first.h", original], ["sdk/include/second.h", second],
        ["sdk/include/duplicate.h", original], ["sdk/include/duplicate.h", second],
        ["sdk/include/oversize.h", "x".repeat(2 * 1024 * 1024 + 1)]];
      const archive = tarFixture(entries);
      writeFileSync(join(root, "payload.tar"), archive);
      const inventory = JSON.stringify({ artifact: "payload.tar", sha256: createHash("sha256").update(archive).digest("hex"), files: entries.map(([name]) => name) });
      writeFileSync(join(root, "inventory.json"), inventory);
      const snapshot = JSON.stringify({ schema: 1, name: "boundary-sdk", versionKind: "release", version: "2.0", files: entries.map(([name]) => name),
        evidence: [{ path: "inventory.json", sha256: createHash("sha256").update(inventory).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), snapshot);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      const req = { ...requirement("Boundary", "", "find_package"), arguments: ["Boundary"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Boundary" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const owner = result.pkgList.find((entry) => entry.name === "boundary-sdk");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.deepEqual(exports.find((entry) => entry.name === "first.h")?.headerDefines, { FIRST_VERSION: "1" });
      assert.equal(exports.find((entry) => entry.name === "first.h")?.materialSha256, createHash("sha256").update(original).digest("hex"));
      assert.deepEqual(exports.find((entry) => entry.name === "second.h")?.headerDefines, { SECOND_VERSION: "2" });
      assert.equal(exports.find((entry) => entry.name === "duplicate.h")?.materialSha256, undefined, "duplicate archive path contents are ambiguous, never concatenated into a forged member");
      assert.equal(exports.find((entry) => entry.name === "oversize.h")?.materialSha256, undefined, "batching does not raise the two-MiB member limit");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires unique regular ZIP members and retains exact BOM-prefixed bytes instead of concatenated exports", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-zip-boundaries-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const original = "\ufeff#define ZIP_VERSION 4\n";
      const entries = [["sdk/include/regular.h", original], ["sdk/include/duplicate.h", "#define ONE 1\n"],
        ["sdk/include/duplicate.h", "#define TWO 2\n"], ["sdk/include/symlink.h", "regular.h", 0o120777]];
      const archive = zipFixture(entries);
      writeFileSync(join(root, "payload.zip"), archive);
      const inventory = JSON.stringify({ artifact: "payload.zip", sha256: createHash("sha256").update(archive).digest("hex"), files: entries.map(([name]) => name) });
      writeFileSync(join(root, "inventory.json"), inventory);
      const snapshot = JSON.stringify({ schema: 1, name: "zip-sdk", versionKind: "release", version: "4.0", files: entries.map(([name]) => name),
        evidence: [{ path: "inventory.json", sha256: createHash("sha256").update(inventory).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), snapshot);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      const req = { ...requirement("Zip", "", "find_package"), arguments: ["Zip"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Zip" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const owner = result.pkgList.find((entry) => entry.name === "zip-sdk");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.equal(exports.find((entry) => entry.name === "regular.h")?.materialSha256, createHash("sha256").update(original).digest("hex"));
      assert.equal(exports.find((entry) => entry.name === "duplicate.h")?.materialSha256, undefined);
      assert.equal(exports.find((entry) => entry.name === "symlink.h")?.materialSha256, undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("carries verified RPM file ownership through supplemental materialization into scoped Find exports", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-authenticated-export-"));
    try {
      const source = join(root, "source"); mkdirSync(join(source, "cmake"), { recursive: true });
      writeFileSync(join(source, "CMakeLists.txt"), "project(Consumer VERSION 1.0)");
      writeFileSync(join(source, "cmake/FindValgrind.cmake"), "find_path(VALGRIND_INCLUDE_DIR NAMES valgrind/valgrind.h)");
      const text = JSON.stringify({ name: "valgrind-devel", version: "3.26.0", release: "1.fc44", arch: "x86_64", files: ["/usr/include/valgrind/valgrind.h"] });
      writeFileSync(join(root, "rpm.json"), text);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "rpm.json", format: "rpm-json", sha256: createHash("sha256").update(text).digest("hex") } }] }));
      const req = { ...requirement("Valgrind", "", "find_package"), file: "CMakeLists.txt", arguments: ["Valgrind"] };
      const available = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Valgrind" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const owner = available.pkgList.find((entry) => entry.version === "3.26.0-1.fc44");
      assert.ok(owner, "scoped header owners must be materialized even when package names differ");
      const exports = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
      assert.ok(exports.some((entry) => entry.name === "valgrind/valgrind.h" && entry.source && entry.provenance?.sha256));
      const index = collectNativeProviders([{ directory: source, component: { name: "Consumer", version: "1.0", "bom-ref": "consumer" } }], { scanRoot: source, availableProviders: available.pkgList });
      assert.equal(resolveNativeRequirements([req], index).bindings[0]?.providers[0].version, "3.26.0-1.fc44");
      writeFileSync(join(root, "rpm.json"), text.replace("3.26.0", "9.99.0"));
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Valgrind" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps cached owner versions available when a known CONFIG identity has unknown search roots", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-owner-before-search-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const text = JSON.stringify({ name: "actual-owner", version: "2.0", release: "1", files: ["/usr/lib/cmake/Public/PublicConfig.cmake"] });
      writeFileSync(join(root, "rpm.json"), text);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "rpm.json", format: "rpm-json", sha256: createHash("sha256").update(text).digest("hex") } }] }));
      const req = { ...requirement("Public", "1.0", "find_package"), arguments: ["Public", "1.0", "CONFIG", "HINTS", "${UNRESOLVED_ROOT}"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Public" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.ok(result.pkgList.some((entry) => entry.name === "actual-owner" && entry.version === "2.0-1"));
      assert.ok(result.pkgList.some((entry) => entry.name === "Public" && !entry.version));
      assert.ok(result.pkgList.filter((entry) => entry.version).every((entry) => entry.properties.some((property) => property.name === "cdx:native:selection" && property.value === "available-not-selected")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps source-declared package exports available without claiming finder satisfaction", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-source-export-before-search-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const config = "configure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake INSTALL_DESTINATION lib/cmake/Public)";
      writeFileSync(join(root, "CMakeLists.txt"), config);
      const text = JSON.stringify({ schema: 1, name: "actual-owner", versionKind: "release", version: "2.0",
        exports: [{ kind: "cmake-package", name: "public", sourceDeclared: true }],
        evidence: [{ path: "CMakeLists.txt", sha256: createHash("sha256").update(config).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), text);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(text).digest("hex") } }] }));
      const req = { ...requirement("Public", "", "find_package"), arguments: ["Public"], conditions: ["if(WITH_PUBLIC)"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Public" }], [], { nativeProviderMetadata: manifest });
      assert.ok(result.pkgList.some((entry) => entry.name === "actual-owner" && entry.version === "2.0"));
      assert.ok(result.pkgList.some((entry) => entry.name === "Public" && !entry.version),
        "generated config declaration is not sufficient to resolve the original finder eagerly");
      assert.ok(!result.pkgList.some((entry) => entry.version && entry.properties.some((property) =>
        property.name === "cdx:build:requirement" && JSON.parse(property.value).providerCandidates.some((candidate) => candidate.compatibility === "satisfied"))));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });


  it("observes exact FLEX/BISON/Doxygen/LLVM tool outputs and rejects malformed or source-local probes", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-exact-tool-"));
    const oldPath = process.env.PATH;
    const cases = [
      ["FLEX", "flex", "flex 2.6.4", "2.6.4"],
      ["BISON", "bison", "bison (GNU Bison) 3.8.2\nCopyright (C) 2021 Free Software Foundation, Inc.", "3.8.2"],
      ["Doxygen", "doxygen", "1.16.1", "1.16.1"],
      ["LLVMAr", "llvm-ar", "LLVM (http://llvm.org/):\n  LLVM version 17.0.6\n  Optimized build.", "17.0.6"],
      ["LLVMNm", "llvm-nm", "llvm-nm, compatible with GNU nm\nLLVM (http://llvm.org/):\n  LLVM version 18.1.2\n  Optimized build.", "18.1.2"],
      ["LLVMRanLib", "llvm-ranlib", "LLVM (http://llvm.org/):\n  LLVM version 19.0.1\n  Optimized build.", "19.0.1"],
    ];
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const sourceBin = join(source, "bin"); mkdirSync(sourceBin);
      const program = (dir, name, text) => {
        const path = join(dir, name);
        writeFileSync(path, `#!/bin/sh\ntest "$1" = "--version" || exit 2\nprintf '%s\\n' '${text}'\n`);
        chmodSync(path, 0o755);
      };
      for (const [, binary, text] of cases) { program(bin, binary, text); program(sourceBin, binary, text); }
      process.env.PATH = bin;
      for (const [name, binary, , version] of cases) {
        const req = { ...requirement(name, "", "find_package"), arguments: [name] };
        const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name }], [], enabled);
        const observed = result.pkgList.find((p) => p.version);
        assert.equal(observed?.version, version, `${name} must use its own executable output`);
        const evidence = JSON.parse(observed.properties.find((p) => p.name === "cdx:native:providerEvidence").value);
        assert.equal(evidence.name, binary);
        assert.equal(evidence.path, join(bin, binary));
        program(bin, binary, "malformed-version-output 2099.7");
        assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name }], [], enabled).observedProviders, 0);
      }
      process.env.PATH = sourceBin;
      for (const [name] of cases) {
        const req = { ...requirement(name, "", "find_package"), arguments: [name] };
        assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name }], [], enabled).observedProviders, 0, `${name} must never execute source PATH tools`);
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds actual framework owners and complete platform-compatible module sets without an invented aggregate release", () => {
    assert.equal(nativeProviderPlatformAccepts({ platform: "watchos" }, { conditions: ["if(APPLE)", "if(APPLE_EMBEDDED)"] }), true);
    assert.equal(nativeProviderPlatformAccepts({ platform: "watchos" }, { conditions: ["if(NOT APPLE)"] }), false);
    assert.equal(nativeProviderPlatformAccepts({ platform: "darwin" }, { conditions: ["if(APPLE_EMBEDDED)"] }), false);
    assert.equal(nativeProviderPlatformAccepts({ platform: "ios" }, { conditions: ["if(APPLE_EMBEDDED STREQUAL watchos)"] }), false);
    assert.equal(nativeProviderPlatformAccepts({ platform: "watchos" }, { conditions: ["if(APPLE_EMBEDDED STREQUAL watchos)"] }), true);
    assert.equal(nativeProviderPlatformAccepts({ platform: "darwin" }, { conditions: ["if(CMAKE_SYSTEM_NAME STREQUAL Linux)/elseif(CMAKE_SYSTEM_NAME STREQUAL Darwin)"] }), true);
    assert.equal(nativeProviderPlatformAccepts({ platform: "linux" }, { conditions: ["if(CMAKE_SYSTEM_NAME STREQUAL Linux)/elseif(CMAKE_SYSTEM_NAME STREQUAL Darwin)"] }), false);
    const root = mkdtempSync(join(tmpdir(), "cdx-framework-provider-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const providers = [];
      for (const [name, version, platform] of [["Foundation", "2.4", "darwin"], ["Metal", "4.1", "darwin"], ["FrontBoardServices", "0", "ios"]]) {
        const original = `install-name: /System/Library/Frameworks/${name}.framework/${name}\ncurrent-version: ${version}\n`;
        writeFileSync(join(root, `${name}.tbd`), original);
        const snapshot = JSON.stringify({ schema: 1, name, versionKind: "release", version, platform,
          exports: [{ kind: "framework", name }], evidence: [{ path: `${name}.tbd`, sha256: createHash("sha256").update(original).digest("hex") }] });
        writeFileSync(join(root, `${name}.json`), snapshot);
        providers.push({ metadata: { path: `${name}.json`, format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } });
      }
      const manifest = join(root, "providers.json"); writeFileSync(manifest, JSON.stringify({ schema: 1, providers }));
      const options = { ...enabled, nativeProviderMetadata: manifest };
      const req = { ...requirement("appleframeworks"), arguments: ["'appleframeworks'", "modules : ['Foundation', 'Metal']"], conditions: ["if with_platform_macos"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "appleframeworks" }], [], options);
      assert.deepEqual(result.pkgList.map((p) => [p.name, p.version]), [["Foundation", "2.4"], ["Metal", "4.1"]]);
      const incomplete = { ...req, arguments: ["'appleframeworks'", "modules : ['Foundation', 'MissingFramework']"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([incomplete]), name: "appleframeworks" }], [], options).observedProviders, 0);
      const mixedPlatforms = { ...req, conditions: [], arguments: ["'appleframeworks'", "modules : ['Foundation', 'FrontBoardServices']"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([mixedPlatforms]), name: "appleframeworks" }], [], options).observedProviders, 0, "different platform SDK fragments must not form a complete module set");
      const library = { ...requirement("Foundation", "", "find_library"), arguments: ["FOUNDATION_LIBRARY", "NAMES", "Foundation"], conditions: ["if(APPLE)"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([library]), name: "Foundation" }], [], options).pkgList.find((p) => p.version)?.version, "2.4");
      const unknown = { ...library, requestedName: "UnknownFoundation", arguments: ["FOUNDATION_LIBRARY", "NAMES", "UnknownFoundation"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([unknown]), name: "UnknownFoundation" }], [], options).observedProviders, 0);
      const pcOnly = { ...requirement("Foundation"), arguments: ["'Foundation'", "method : 'pkg-config'"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([pcOnly]), name: "Foundation" }], [], options).observedProviders, 0, "an explicit pkg-config method cannot use an SDK framework");
      const explicitFramework = { ...pcOnly, arguments: ["'Foundation'", "method : 'extraframework'"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([explicitFramework]), name: "Foundation" }], [], options).pkgList.find((p) => p.version)?.version, "2.4");
      const pcOnlySet = { ...req, arguments: [...req.arguments, "method : 'pkg-config'"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([pcOnlySet]), name: "appleframeworks" }], [], options).observedProviders, 0);
      const dynamic = { ...req, arguments: ["'appleframeworks'", "modules : module_variable"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([dynamic]), name: "appleframeworks" }], [], options).observedProviders, 0);
      const single = { ...requirement("FrontBoardServices"), conditions: ["if(APPLE)"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([single]), name: "FrontBoardServices" }], [], options).pkgList.find((p) => p.version !== undefined)?.version, "0");
      const api = { ...single, constraints: ">=1" };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([api]), name: "FrontBoardServices" }], [], options).observedProviders, 0, "Mach-O linker current-version must not become an API compatibility assertion");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains actual Windows import-library filenames alongside case-insensitive finder names", () => {
    const path = "c/um/x64/ShLwApi.Lib";
    const exports = nativePackageFileExports([path]);
    const match = exports.find((entry) => entry.kind === "library" && entry.name === "shlwapi");
    assert.equal(match?.file, path);
    assert.equal(match?.filename, "ShLwApi.Lib");
    assert.equal(match?.material, "windows-library");
  });

  it("retains a matching SDK framework stub as an unknown guarded library candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-sdk-framework-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const name = "AFramework";
      const sdk = { directory: "iPhoneOS17.4.sdk", version: "17.4", canonicalName: "iphoneos17.4", repository: "https://example.org/sdk", revision: "a".repeat(40) };
      const installName = `/System/Library/PrivateFrameworks/${name}.framework/${name}`;
      const file = `${sdk.directory}${installName}.tbd`;
      mkdirSync(join(root, sdk.directory, "System/Library/PrivateFrameworks", `${name}.framework`), { recursive: true });
      const original = `---\ninstall-name: ${installName}\ncurrent-version: 1.2\n...`;
      writeFileSync(join(root, file), original);
      const snapshot = JSON.stringify({ schema: 1, name, version: "1.2", versionKind: "release", platform: "ios", sdk, installName, versionSource: "tbd-current-version",
        exports: [{ kind: "framework", name }], evidence: [{ path: file, sha256: createHash("sha256").update(original).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), snapshot);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      const options = { nativeProviderMetadata: manifest, nativeVersionProbes: false };
      const req = { ...requirement(name, "", "find_library"), arguments: ["LIB", name, "PATHS", "${CMAKE_OSX_SYSROOT}/System/Library/PrivateFrameworks"], conditions: ["if(APPLE)", "if(APPLE_EMBEDDED)"] };
      const available = resolveNativeAvailableProviders(source, [{ ...component([req]), name }], [], options);
      assert.equal(available.pkgList.find((entry) => entry.version)?.version, "1.2");
      const index = collectNativeProviders([], { scanRoot: source, availableProviders: available.pkgList, ...options });
      const result = resolveNativeRequirements([req], index);
      assert.equal(result.bindings.length, 0);
      assert.equal(result.unresolved[0].candidates[0].compatibility, "unknown");
      const wrong = { ...req, arguments: ["LIB", name, "PATHS", "${CMAKE_OSX_SYSROOT}/System/Library/Frameworks"] };
      assert.equal(resolveNativeRequirements([wrong], index).unresolved[0].candidates.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("checks the actual pc interface version without relabeling the owning source release", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-interface-version-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const dir = "source-metadata/archive/owner"; mkdirSync(join(root, dir), { recursive: true });
      const descriptor = (path, text, format) => { writeFileSync(join(root, path), text); return { path, sha256: createHash("sha256").update(text).digest("hex"), ...(format ? { format } : {}) }; };
      const metadata = descriptor("vcpkg.json", JSON.stringify({ name: "interface-owner", version: "2.24.1" }), "vcpkg-json");
      const recipe = descriptor("portfile.cmake", `vcpkg_from_github(REPO owner/interface REF v2.24.1 SHA512 ${"a".repeat(128)})\n`);
      const supplemental = [
        descriptor(`${dir}/api-module.pc.in`, "Name: API\nVersion: @API_VERSION@\n"),
        descriptor(`${dir}/meson.build`, "major = 1\nminor = 24\nmicro = 0\napi_version = '@0@.@1@.@2@'.format(major, minor, micro)\ncfg.set('API_VERSION', api_version)\n"),
        descriptor("source-metadata/archive/archive-manifest.json", JSON.stringify({ members: ["owner/api-module.pc.in", "owner/meson.build"] })),
      ];
      const manifest = join(root, "providers.json"); writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata, recipe, supplemental, registryRevision: "a".repeat(40) }] }));
      const good = requirement("api-module", ">=1.0");
      const result = resolveNativeAvailableProviders(source, [{ ...component([good]), name: "api-module" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.equal(result.pkgList.find((p) => p.version)?.version, "2.24.1", "the owner keeps its real release, not interface version 1.24.0");
      const bad = { ...good, constraints: ">=2.0" };
      assertUnselectedOwner(resolveNativeAvailableProviders(source, [{ ...component([bad]), name: "api-module" }], [], { ...enabled, nativeProviderMetadata: manifest }), bad, source, "interface-owner", "2.24.1", "violated");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses a real Windows tool package alternative rather than the host Linux executable version", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-windows-tool-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const original = JSON.stringify({ tag_name: "v2.56.0.windows.4", files: ["cmd/git.exe"] });
      writeFileSync(join(root, "release.json"), original);
      const snapshot = JSON.stringify({ schema: 1, name: "git-for-windows", versionKind: "release", version: "2.56.0.windows.4", platform: "win32",
        exports: [{ kind: "tool", name: "git" }], evidence: [{ path: "release.json", sha256: createHash("sha256").update(original).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), snapshot);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      const req = { ...requirement("Git", "", "find_package"), arguments: ["Git", "QUIET"], conditions: ["if(WIN32)"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "Git" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.equal(result.pkgList.find((p) => p.version)?.name, "git-for-windows");
      assert.equal(result.pkgList.find((p) => p.version)?.version, "2.56.0.windows.4");
      const record = JSON.parse(result.pkgList.find((p) => p.version).properties.find((p) => p.name === "cdx:build:requirement").value);
      assert.deepEqual(record.conditions, ["if(WIN32)"]);
      assert.equal(record.providerCandidates.at(-1).selected, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("observes cached program owners for parser-emitted find_program tool requirements", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-cached-find-program-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const cmake = join(source, "CMakeLists.txt");
      const script = "find_program(SHORT cdx-short cdx-search-dir)\nfind_program(LONG NAMES cdx-first cdx-second DOC cdx-doc VALIDATOR cdx-validator NO_CACHE OPTIONAL)\n";
      writeFileSync(cmake, script);
      const providers = ["cdx-short", "cdx-first", "cdx-second", "cdx-search-dir", "cdx-doc", "cdx-validator"].map((name) => {
        const path = `${name}.json`;
        const text = JSON.stringify({ name: `${name}-owner`, version: "2.0", release: "1.local", files: [`/usr/bin/${name}`] });
        writeFileSync(join(root, path), text);
        return { platform: process.platform, metadata: { path, format: "rpm-json", sha256: createHash("sha256").update(text).digest("hex") } };
      });
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers }));
      const { pkgList } = parseCmakeLikeFile(cmake, "generic", { sourceRoot: source, nativeDependencyFacts: true });
      const requests = pkgList.flatMap((entry) => entry.properties || []).filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
      assert.deepEqual(requests.map((request) => request.role), ["tool", "tool"]);
      const result = resolveNativeAvailableProviders(source, pkgList, [], { nativeProviderMetadata: manifest });
      assert.deepEqual(result.pkgList.filter((entry) => entry.version).map((entry) => entry.name),
        ["cdx-short-owner", "cdx-first-owner", "cdx-second-owner"]);
      assert.deepEqual(result.pkgList.filter((entry) => !entry.version), pkgList);
      assert.ok(result.pkgList.filter((entry) => entry.version).every((entry) => entry.properties.some((p) =>
        p.name === "cdx:native:selection" && p.value === "available-not-selected")));
      assert.equal(readFileSync(cmake, "utf8"), script);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains header-only cached owners as available inventory without pretending a CMake binding exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-header-provider-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const headerPath = "source-metadata/archive/half/include/half.hpp";
      mkdirSync(join(root, "source-metadata/archive/half/include"), { recursive: true });
      const descriptor = (path, text, format) => { writeFileSync(join(root, path), text); return { path, sha256: createHash("sha256").update(text).digest("hex"), ...(format ? { format } : {}) }; };
      const header = descriptor(headerPath, "#define HALF_VERSION 20201\n");
      const metadata = descriptor("vcpkg.json", JSON.stringify({ name: "half", version: "2.2.1" }), "vcpkg-json");
      const recipe = descriptor("portfile.cmake", `vcpkg_from_github(REPO owner/half REF v2.2.1 SHA512 ${"a".repeat(128)})\n`);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata, recipe, supplemental: [header], registryRevision: "a".repeat(40) }] }));
      const req = { ...requirement("HALF", ">=2.0", "find_package"), arguments: ["HALF", "2.0"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "HALF" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.ok(result.pkgList.some((p) => !p.version && p.name === "HALF"), "the original requirement remains unresolved until the Find-module header bridge proves ownership");
      const available = result.pkgList.find((p) => p.version && p.name === "half");
      assert.equal(available?.version, "2.2.1");
      const exports = JSON.parse(available.properties.find((p) => p.name === "cdx:native:providerExports").value);
      assert.ok(exports.some((e) => e.kind === "header-file" && e.name === "half.hpp" && e.source === join(root, headerPath)));
      assert.ok(!exports.some((e) => e.kind === "cmake-package"), "no HALFConfig is invented");
      assert.ok(available.properties.some((p) => p.name === "cdx:native:selection" && p.value === "available-not-selected"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves Meson else polarity and does not infer contradictions from compound expressions", () => {
    const linux = { platform: "linux" }; const windows = { platform: "win32" };
    assert.equal(nativeProviderPlatformAccepts(linux, { conditions: ["if host_machine.system() == 'windows'/else"] }), true);
    assert.equal(nativeProviderPlatformAccepts(windows, { conditions: ["if host_machine.system() == 'windows'/else"] }), false);
    assert.equal(nativeProviderPlatformAccepts(linux, { conditions: ["if host_machine.system() != 'windows'/else"] }), false);
    assert.equal(nativeProviderPlatformAccepts(linux, { conditions: ["if host_machine.system() == 'windows' or optional_feature"] }), true);
    assert.equal(nativeProviderPlatformAccepts(linux, { conditions: ["if host_machine.system() == 'darwin'/else"] }), true);
  });

  it("requires both opt-ins and never probes missing providers into fake versions", () => {
    const c = component([requirement("cdx-missing-provider-f04736")]);
    for (const options of [{}, { introspect: true }, { nativeVersionProbes: true }, { ...enabled, introspect: false }]) {
      const r = resolveNativeAvailableProviders(tmpdir(), [c], [], options);
      assert.equal(r.pkgList[0], c);
      assert.equal(r.observedProviders, 0);
    }
    assert.equal(resolveNativeAvailableProviders(tmpdir(), [c], [], enabled).observedProviders, 0);
  });

  it("binds actual pc versions, splits incompatible callsites and expands graph refs without selecting", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-available-provider-"));
    const old = process.env.PKG_CONFIG_LIBDIR;
    const oldPath = process.env.PKG_CONFIG_PATH;
    try {
      const source = join(root, "source");
      const metadata = join(root, "installed");
      mkdirSync(source); mkdirSync(metadata);
      const pc = join(metadata, "cdx-fixture-provider.pc");
      writeFileSync(pc, "prefix=/opt/cdx-fixture\nName: fixture\nDescription: real installed metadata fixture\nVersion: 2.7.4\nLibs: -lcdxfixture\n");
      process.env.PKG_CONFIG_LIBDIR = metadata;
      process.env.PKG_CONFIG_PATH = "";
      const good = requirement("cdx-fixture-provider", ">=2.0");
      const bad = { ...requirement("cdx-fixture-provider", ">=9.0"), line: 5 };
      const c = component([good, bad]);
      const r = resolveNativeAvailableProviders(source, [c], [{ ref: "root", dependsOn: ["requirement"] }, { ref: "requirement", dependsOn: ["child"], provides: ["requirement"] }], enabled);
      const provider = r.pkgList.find((p) => p.version);
      const unbound = r.pkgList.find((p) => !p.version);
      assert.equal(provider.version, "2.7.4");
      assert.equal(r.observedProviders, 1);
      const record = JSON.parse(provider.properties.find((p) => p.name === "cdx:build:requirement").value);
      assert.equal(record.providerCandidates.at(-1).selected, false);
      assert.equal(record.providerCandidates.at(-1).kind, "available-environment-provider");
      assert.equal(JSON.parse(unbound.properties.find((p) => p.name === "cdx:build:requirement").value).constraints, ">=9.0");
      assert.ok(provider.properties.some((p) => p.name === "cdx:native:providerEvidence" && JSON.parse(p.value).metadataPath === pc));
      assert.deepEqual(r.dependencies.find((d) => d.ref === "root").dependsOn, r.remap.get("requirement"));
      assert.ok(r.dependencies.some((d) => d.ref === provider["bom-ref"] && d.dependsOn.includes("child")));
      assert.equal(c.version, undefined);
      assertUnselectedOwner(resolveNativeAvailableProviders(source, [component([bad])], [], enabled), bad, source, "cdx-fixture-provider", "2.7.4", "violated");
      const consumer = { ...component([good]), name: "actual-consumer-project" };
      assert.equal(resolveNativeAvailableProviders(source, [consumer], [], enabled).observedProviders, 0, "consumer metadata must not inherit dependency versions");
      const unknown = { ...good, command: "find_package", arguments: ["cdx-fixture-provider"] };
      assert.equal(resolveNativeAvailableProviders(source, [component([unknown])], [], enabled).observedProviders, 0, "no normalized CMake-name guessing");
      const unsupported = { ...good, constraints: "'>=' + variable" };
      assertUnselectedOwner(resolveNativeAvailableProviders(source, [component([unsupported])], [], enabled), unsupported, source, "cdx-fixture-provider", "2.7.4", "unknown");
      const crossComponents = { ...requirement("Python3", "", "find_package"), arguments: ["Python3", "COMPONENTS", "Development"] };
      assert.ok(resolveNativeAvailableProviders(source, [{ ...component([crossComponents]), name: "Python3" }], [], enabled).pkgList.some((entry) => entry.name === "Python3" && !entry.version), "actual Python owner availability is separate from development predicate resolution");
      process.env.PKG_CONFIG_LIBDIR = source;
      writeFileSync(join(source, "cdx-fixture-provider.pc"), readFileSync(pc));
      assert.equal(resolveNativeAvailableProviders(source, [component([good])], [], enabled).observedProviders, 0, "source metadata is not an installed provider");
      process.env.PKG_CONFIG_LIBDIR = metadata;
      writeFileSync(pc, `${readFileSync(pc, "utf8")}\n#${"x".repeat(1024 * 1024)}\n`);
      assert.equal(resolveNativeAvailableProviders(source, [component([good])], [], enabled).observedProviders, 0, "oversized metadata is not accepted");
    } finally {
      if (old === undefined) delete process.env.PKG_CONFIG_LIBDIR; else process.env.PKG_CONFIG_LIBDIR = old;
      if (oldPath === undefined) delete process.env.PKG_CONFIG_PATH; else process.env.PKG_CONFIG_PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("observes installed metadata rather than an adjacent preferred uninstalled provider", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-installed-pc-"));
    const old = process.env.PKG_CONFIG_LIBDIR;
    const oldPath = process.env.PKG_CONFIG_PATH;
    try {
      const source = join(root, "source");
      const metadata = join(root, "installed");
      mkdirSync(source); mkdirSync(metadata);
      const pc = join(metadata, "cdx-fixture-provider.pc");
      const text = "Name: fixture\nDescription: installed provider\nVersion: 1.0\n";
      writeFileSync(pc, text);
      writeFileSync(join(metadata, "cdx-fixture-provider-uninstalled.pc"), text.replace("1.0", "9.0"));
      process.env.PKG_CONFIG_LIBDIR = metadata;
      process.env.PKG_CONFIG_PATH = metadata;
      const result = resolveNativeAvailableProviders(source, [component([requirement("cdx-fixture-provider")])], [], enabled);
      const provider = result.pkgList.find((p) => p.version);
      assert.equal(provider.version, "1.0");
      const evidence = JSON.parse(provider.properties.find((p) => p.name === "cdx:native:providerEvidence").value);
      assert.equal(evidence.metadataPath, pc);
      assert.equal(evidence.metadataSha256, createHash("sha256").update(text).digest("hex"));
    } finally {
      if (old === undefined) delete process.env.PKG_CONFIG_LIBDIR; else process.env.PKG_CONFIG_LIBDIR = old;
      if (oldPath === undefined) delete process.env.PKG_CONFIG_PATH; else process.env.PKG_CONFIG_PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a cross-platform source revision only for unconstrained SDK exports with intact original evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-platform-source-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const revision = "a".repeat(40);
      const original = `cc_library_shared { name: "nativefixture", }\n`;
      writeFileSync(join(root, "Android.bp"), original);
      const snapshot = JSON.stringify({ schema: 1, name: "android-fixture", versionKind: "source-revision", version: revision,
        repository: "https://android.googlesource.com/platform/fixture", platform: "android",
        exports: [{ kind: "library", name: "nativefixture" }, { kind: "meson-dependency", name: "android-nativefixture" }],
        evidence: [{ path: "Android.bp", sha256: createHash("sha256").update(original).digest("hex") }] });
      writeFileSync(join(root, "snapshot.json"), snapshot);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      const req = { ...requirement("nativefixture", "", "find_library"), arguments: ["NATIVE_LIBRARY", "NAMES", "nativefixture"], conditions: ["if(ANDROID)"] };
      const constrained = { ...req, line: 9, constraints: ">=1.0" };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req, constrained]), name: "nativefixture" }], [], { ...enabled, nativeProviderMetadata: manifest });
      const provider = result.pkgList.find((p) => p.version);
      assert.equal(provider?.version, revision);
      assert.equal(provider?.name, "android-fixture");
      assert.ok(provider.purl.includes("vcs_url="));
      assert.ok(provider.externalReferences.some((ref) => ref.type === "vcs" && ref.url === "https://android.googlesource.com/platform/fixture"));
      const alternative = { ...req, requestedName: "nativefixture-alternative", arguments: ["NATIVE_LIBRARY", "NAMES", "absent-library-name", "nativefixture", "another-absent-name"] };
      const alternativeResult = resolveNativeAvailableProviders(source, [{ ...component([alternative]), name: "nativefixture-alternative" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.equal(alternativeResult.pkgList.find((p) => p.version)?.version, revision, "find_library NAMES is an OR over the whole original alternative list");
      const alternativeRecord = JSON.parse(alternativeResult.pkgList[0].properties.find((p) => p.name === "cdx:build:requirement").value);
      assert.deepEqual(alternativeRecord.arguments, ["NATIVE_LIBRARY", "NAMES", "absent-library-name", "nativefixture", "another-absent-name"]);
      assert.equal(alternativeRecord.providerCandidates.at(-1).selected, false);
      assert.ok(provider.properties.some((p) => p.name === "cdx:version:kind" && p.value === "source-revision"));
      assert.equal(result.pkgList.filter((p) => !p.version).length, 1);
      const meson = requirement("android-nativefixture");
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([meson]), name: "android-nativefixture" }], [], { ...enabled, nativeProviderMetadata: manifest }).pkgList.find((p) => p.version)?.version, revision);
      const unrelatedModule = requirement("nativefixture");
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([unrelatedModule]), name: "nativefixture" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0, "library exports must not invent pkg-config module identities");
      writeFileSync(join(root, "Android.bp"), original.replace("nativefixture", "other"));
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name: "nativefixture" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
      writeFileSync(manifest, "null");
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name: "nativefixture" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the owning package of an installed CMake config, not a same-name guess", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-cmake-owner-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const library = join(root, "libfixture.so"); writeFileSync(library, "installed fixture");
      const configs = join(root, "cmake", "FixtureSDK"); mkdirSync(configs, { recursive: true });
      const config = join(configs, "FixtureSDKConfig.cmake"); writeFileSync(config, "set(FixtureSDK_FOUND TRUE)\\n");
      const executable = (name, text) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${text}\n`); chmodSync(path, 0o755); };
      executable("ldconfig", `printf '%s\\n' 'libfixture.so (libc6,x86-64) => ${library}'`);
      executable("rpm", `test "$2" = "${config}" || exit 1\nprintf 'fixture-devel\\t0\\t7.3.1\\t1.fixture\\tx86_64\\n'`);
      process.env.PATH = bin;
      const req = { ...requirement("FixtureSDK", "", "find_package"), arguments: ["FixtureSDK", "CONFIG"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "FixtureSDK" }], [], enabled);
      assert.equal(result.pkgList.find((p) => p.version)?.name, "fixture-devel");
      assert.equal(result.pkgList.find((p) => p.version)?.version, "7.3.1-1.fixture");
      const apiConstraint = { ...req, constraints: ">=7.1" };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([apiConstraint]), name: "FixtureSDK" }], [], enabled).observedProviders, 0, "package-file ownership alone cannot prove a CMake API version");
      const provider = result.pkgList.find((p) => p.version);
      const evidence = JSON.parse(provider.properties.find((p) => p.name === "cdx:native:providerEvidence").value);
      assert.equal(evidence.providedFilePath, config);
      const copied = { ...provider, properties: [...provider.properties, { name: "fixture:accumulated", value: "unrelated provenance" }] };
      const indexed = collectNativeProviders([], { scanRoot: source, availableProviders: [copied] });
      assert.equal(resolveNativeRequirements([req], indexed).bindings[0]?.providers[0].version, "7.3.1-1.fixture");
      assert.equal(JSON.stringify(copied).includes("native-observed-provider"), false);
      const tamperedCopy = { ...copied, version: "99.0" };
      assert.equal(collectNativeProviders([], { scanRoot: source, availableProviders: [tamperedCopy] }).providers.length, 0);
      const forged = structuredClone(provider);
      const exportProperty = forged.properties.find((entry) => entry.name === "cdx:native:providerExports");
      exportProperty.value = JSON.stringify([{ kind: "cmake-package", name: "StolenSDK", source: config }]);
      assert.equal(collectNativeProviders([], { scanRoot: source, availableProviders: [forged] }).providers.length, 0);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds an exact CMake export from a concrete source-acquiring registry recipe", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-vcpkg-recipe-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const pkg = JSON.stringify({ name: "fixture-sdk", "version-semver": "4.2.1", "port-version": 3 });
      const recipe = `vcpkg_from_github(OUT_SOURCE_PATH SOURCE_PATH REPO example/fixture REF v4.2.1 SHA512 ${"a".repeat(128)})\nvcpkg_cmake_config_fixup(PACKAGE_NAME FixtureSDK)\n`;
      const descriptor = (path, text, format) => { writeFileSync(join(root, path), text); return { path, sha256: createHash("sha256").update(text).digest("hex"), ...(format ? { format } : {}) }; };
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: descriptor("vcpkg.json", pkg, "vcpkg-json"), recipe: descriptor("portfile.cmake", recipe), registryRevision: "a".repeat(40) }] }));
      const req = { ...requirement("FixtureSDK", "4.0", "find_package"), arguments: ["FixtureSDK", "4.0", "CONFIG"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "FixtureSDK" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.equal(result.pkgList.find((p) => p.version)?.name, "fixture-sdk");
      assert.equal(result.pkgList.find((p) => p.version)?.version, "4.2.1");
      const forwarded = { ...req, command: "find_dependency" };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([forwarded]), name: "FixtureSDK" }], [], { ...enabled, nativeProviderMetadata: manifest }).pkgList.find((p) => p.version)?.version, "4.2.1");
      const exact = { ...forwarded, constraints: "4.0 EXACT" };
      assertUnselectedOwner(resolveNativeAvailableProviders(source, [{ ...component([exact]), name: "FixtureSDK" }], [], { ...enabled, nativeProviderMetadata: manifest }), exact, source, "fixture-sdk", "4.2.1", "violated");
      const sourceRef = "pkg:generic/FixtureSDK@1.2.3";
      const sourceReq = { ...req, constraints: "", arguments: ["FixtureSDK", "CONFIG"], providerCandidates: [{ kind: "source-project", ref: sourceRef, selected: false }] };
      const owned = { ...component([sourceReq]), name: "FixtureSDK", version: "1.2.3", "bom-ref": sourceRef,
        externalReferences: [{ type: "vcs", url: "https://example.invalid/source-widget" }],
        properties: [...component([sourceReq]).properties, { name: "cdx:cmake:resolvedVia", value: "source-candidate" },
          { name: "cdx:cmake:sourceDir", value: "source/widget" }, { name: "cdx:version:sourceRevision", value: "b".repeat(40) }] };
      const alternatives = resolveNativeAvailableProviders(source, [owned], [{ ref: "consumer", dependsOn: [sourceRef] }, { ref: sourceRef, dependsOn: ["source-only-child"] }], { ...enabled, nativeProviderMetadata: manifest });
      assert.ok(alternatives.pkgList.includes(owned), "the pre-resolved source release is retained unchanged");
      assert.equal(owned.version, "1.2.3");
      const external = alternatives.pkgList.find((p) => p.name === "fixture-sdk" && p.version === "4.2.1");
      assert.ok(external, "a source-candidate version does not suppress an external alternative");
      assert.deepEqual(alternatives.remap.get(sourceRef), [sourceRef, external["bom-ref"]]);
      assert.deepEqual(alternatives.dependencies.find((edge) => edge.ref === "consumer").dependsOn, [sourceRef, external["bom-ref"]]);
      assert.deepEqual(alternatives.dependencies.find((edge) => edge.ref === sourceRef).dependsOn, ["source-only-child"]);
      assert.ok(!alternatives.dependencies.some((edge) => edge.ref === external["bom-ref"] && edge.dependsOn.includes("source-only-child")), "source-owned outgoing edges do not become external package dependencies");
      assert.ok(!external.properties.some((p) => p.name === "cdx:cmake:resolvedVia" && p.value === "source-candidate"));
      assert.ok(!external.properties.some((p) => p.name === "cdx:version:sourceRevision"));
      assert.ok(!external.externalReferences?.some((ref) => ref.url === "https://example.invalid/source-widget"));
      const consumerProject = { ...owned, name: "different-consumer-project" };
      const consumerResult = resolveNativeAvailableProviders(source, [consumerProject], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.ok(consumerResult.pkgList.includes(consumerProject), "versioned consumers retain their own identity");
      assert.equal(consumerProject.name, "different-consumer-project");
      assert.equal(consumerProject.version, "1.2.3", "dependency availability must not become the consumer's version");
      assert.ok(!consumerResult.remap.has(consumerProject["bom-ref"]), "an independent available dependency does not remap the consumer");
      const availableDependency = consumerResult.pkgList.find((entry) => entry !== consumerProject && entry.name === "fixture-sdk" && entry.version === "4.2.1");
      assert.ok(availableDependency?.properties.some((entry) => entry.name === "cdx:native:selection" && entry.value === "available-not-selected"));
      assert.ok(!availableDependency.properties.some((entry) => entry.name === "cdx:cmake:resolvedVia" && entry.value === "source-candidate"));
      const wrong = { ...req, requestedName: "UnrelatedSDK" };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([wrong]), name: "UnrelatedSDK" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
      writeFileSync(join(root, "portfile.cmake"), "find_package(FixtureSDK)\n");
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([req]), name: "FixtureSDK" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains Debian epoch and revision from the package that owns the installed library", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-dpkg-owner-"));
    const oldPath = process.env.PATH;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const library = join(root, "libdebfixture.so.2"); writeFileSync(library, "installed fixture");
      const executable = (name, text) => { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${text}\n`); chmodSync(file, 0o755); };
      executable("ldconfig", `printf '%s\\n' 'libdebfixture.so.2 (libc6,x86-64) => ${library}'`);
      executable("dpkg-query", `case "$1" in\n-S) printf 'libdebfixture2:amd64: %s\\n' "$2" ;;\n-W) printf 'libdebfixture2:amd64\\t1:4.2.0-7ubuntu2\\tamd64\\tinstall ok installed\\n' ;;\n*) exit 2 ;;\nesac`);
      process.env.PATH = bin;
      const req = { ...requirement("debfixture", "", "find_library"), arguments: ["FIXTURE_LIBRARY", "NAMES", "debfixture"] };
      const result = resolveNativeAvailableProviders(source, [{ ...component([req]), name: "debfixture" }], [], enabled);
      assert.equal(result.pkgList.find((p) => p.version)?.name, "libdebfixture2");
      assert.equal(result.pkgList.find((p) => p.version)?.version, "1:4.2.0-7ubuntu2");
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps a real library file through rpm ownership to the exact runtime package release", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-library-owner-"));
    const oldPath = process.env.PATH;
    const oldSecret = process.env.CDX_PROVIDER_TEST_SECRET;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const library = join(root, "libfixture.so.1"); writeFileSync(library, "ELF fixture");
      const executable = (name, text) => {
        const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${text}\n`); chmodSync(file, 0o755);
      };
      executable("ldconfig", `test "$1" = "-p" || exit 2\nprintf '%s\\n' 'libfixture.so.1 (libc6,x86-64) => ${library}'`);
      executable("rpm", `test -z "$CDX_PROVIDER_TEST_SECRET" || exit 7\ntest "$1" = "-qf" || exit 2\nprintf 'fixture-runtime\\t0\\t2.7.4\\t9.fixture\\tx86_64\\n'`);
      process.env.PATH = bin; process.env.CDX_PROVIDER_TEST_SECRET = "not-for-subprocesses";
      const req = { ...requirement("fixture", "", "find_library"), arguments: ["FIXTURE_LIBRARY", "NAMES", "fixture"], conditions: ["if(NOT WIN32)"] };
      const c = { ...component([req]), name: "fixture" };
      const result = resolveNativeAvailableProviders(source, [c], [{ ref: "root", dependsOn: ["requirement"] }], enabled);
      const provider = result.pkgList.find((p) => p.version);
      assert.equal(provider?.name, "fixture-runtime");
      assert.equal(provider?.version, "2.7.4-9.fixture");
      const record = JSON.parse(provider.properties.find((p) => p.name === "cdx:build:requirement").value);
      assert.deepEqual(record.conditions, ["if(NOT WIN32)"]);
      assert.equal(record.providerCandidates.at(-1).selected, false);
      const evidence = JSON.parse(provider.properties.find((p) => p.name === "cdx:native:providerEvidence").value);
      assert.equal(evidence.libraryPath, library);
      assert.equal(evidence.packageManager, "rpm");
      assert.equal(evidence.packageName, "fixture-runtime");
      assert.ok(evidence.output.includes("2.7.4"));
      assert.deepEqual(result.dependencies[0].dependsOn, [provider["bom-ref"]]);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldSecret === undefined) delete process.env.CDX_PROVIDER_TEST_SECRET; else process.env.CDX_PROVIDER_TEST_SECRET = oldSecret;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses authenticated metadata without granting permission to execute installed providers", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-passive-provider-"));
    const oldPath = process.env.PATH;
    const oldMetadata = process.env.CDXGEN_NATIVE_PROVIDER_METADATA;
    try {
      const source = join(root, "source"); mkdirSync(source);
      const bin = join(root, "bin"); mkdirSync(bin);
      const marker = join(root, "executed");
      for (const name of ["git", "cmake", "pkg-config", "rpm"]) {
        const executable = join(bin, name);
        writeFileSync(executable, `#!/bin/sh\nprintf executed >> '${marker}'\nexit 9\n`);
        chmodSync(executable, 0o755);
      }
      process.env.PATH = bin;
      const text = JSON.stringify({ name: "passive-devel", version: "4.7", release: "2",
        files: ["/usr/lib/pkgconfig/cdx-fixture-provider.pc"] });
      writeFileSync(join(root, "package.json"), text);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ platform: process.platform,
        metadata: { path: "package.json", format: "rpm-json", sha256: createHash("sha256").update(text).digest("hex") } }] }));
      const inputs = [component([requirement("cdx-fixture-provider")]),
        { ...component([{ ...requirement("Git", "", "find_package"), arguments: ["Git"] }]), name: "Git", "bom-ref": "git-requirement" }];
      for (const permission of [{}, { introspect: true }, { nativeVersionProbes: true }]) {
        const options = { ...permission, installDeps: false, nativeProviderMetadata: manifest };
        const result = resolveNativeAvailableProviders(source, inputs, [], options);
        assert.ok(result.pkgList.some((entry) => entry.name === "passive-devel" && entry.version === "4.7-2"),
          "reading authenticated cached ownership does not require installed execution permission");
        assert.ok(result.pkgList.some((entry) => entry.name === "Git" && !entry.version));
        assert.equal(existsSync(marker), false, "passive cache use must not execute host probes");
      }
      process.env.CDXGEN_NATIVE_PROVIDER_METADATA = manifest;
      const environmentCache = resolveNativeAvailableProviders(source, inputs);
      assert.ok(environmentCache.pkgList.some((entry) => entry.name === "passive-devel" && entry.version === "4.7-2"),
        "explicit environment metadata has the same passive-cache permission boundary");
      const suppressed = resolveNativeAvailableProviders(source, inputs, [], { nativeProviderMetadata: [] });
      assert.ok(!suppressed.pkgList.some((entry) => entry.name === "passive-devel"), "an explicit empty cache list overrides ambient metadata");
      writeFileSync(join(root, "package.json"), text.replace("4.7", "9.9"));
      const tampered = resolveNativeAvailableProviders(source, inputs, [], { nativeProviderMetadata: manifest });
      assert.ok(!tampered.pkgList.some((entry) => entry.name === "passive-devel"), "passive cache still requires matching evidence hashes");
      assert.equal(existsSync(marker), false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldMetadata === undefined) delete process.env.CDXGEN_NATIVE_PROVIDER_METADATA; else process.env.CDXGEN_NATIVE_PROVIDER_METADATA = oldMetadata;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves absent local pc metadata from a hash-verified package file manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-cached-package-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const text = JSON.stringify({ name: "fixture-devel", version: "2.7.4", release: "3.fixture", epoch: 0, arch: process.arch,
        files: ["/usr/lib64/pkgconfig/cdx-fixture-provider.pc", "/usr/lib64/libfixture.so", "/usr/lib64/stubs/libdriveronly.so"] });
      writeFileSync(join(root, "package.json"), text);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ platform: process.platform,
        metadata: { path: "package.json", format: "rpm-json", sha256: createHash("sha256").update(text).digest("hex") } }] }));
      const result = resolveNativeAvailableProviders(source, [component([requirement("cdx-fixture-provider")])], [], { ...enabled, nativeProviderMetadata: manifest });
      const provider = result.pkgList.find((p) => p.version);
      assert.equal(provider?.name, "fixture-devel");
      assert.equal(provider?.version, "2.7.4-3.fixture");
      const constrained = requirement("cdx-fixture-provider", ">=2.0");
      assertUnselectedOwner(resolveNativeAvailableProviders(source, [component([constrained])], [], { ...enabled, nativeProviderMetadata: manifest }), constrained, source, "fixture-devel", "2.7.4-3.fixture", "unknown");
      const stub = { ...requirement("driveronly", "", "find_library"), arguments: ["DRIVER_LIBRARY", "NAMES", "driveronly"] };
      const stubResult = resolveNativeAvailableProviders(source, [{ ...component([stub]), name: "driveronly" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.ok(stubResult.pkgList.some((entry) => entry.name === "fixture-devel" && entry.version === "2.7.4-3.fixture"), "SDK stub ownership remains available inventory");
      assert.ok(stubResult.pkgList.some((entry) => entry.name === "driveronly" && !entry.version), "SDK stub ownership does not prove a driver runtime requirement");
      writeFileSync(join(root, "package.json"), text.replace("2.7.4", "9.9.9"));
      assert.equal(resolveNativeAvailableProviders(source, [component([requirement("cdx-fixture-provider")])], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reuses serialized provider evidence across native consumers without merging their observations", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-shared-provider-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const text = JSON.stringify({ name: "shared-devel", version: "2.7.4", release: "3.fixture",
        files: ["/usr/lib64/pkgconfig/cdx-fixture-provider.pc", ...Array.from({ length: 64 }, (_, i) => `/usr/lib64/libfixture${i}.so`)] });
      writeFileSync(join(root, "package.json"), text);
      const manifest = join(root, "providers.json");
      const hash = (value) => createHash("sha256").update(value).digest("hex");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ platform: process.platform,
        metadata: { path: "package.json", format: "rpm-json", sha256: hash(text) } }] }));
      const consumers = Array.from({ length: 128 }, (_, i) => ({
        ...component(Array.from({ length: 4 }, (_, line) => ({ ...requirement("cdx-fixture-provider"), file: `consumer-${i}/meson.build`, line }))),
        group: `scope-${i % 2}`, "bom-ref": `consumer-${i}`,
      }));
      const stringify = JSON.stringify;
      let evidenceSerializations = 0;
      let result;
      try {
        JSON.stringify = (value, ...args) => {
          if (value?.kind === "package-manifest" && value.name === "shared-devel") evidenceSerializations++;
          return stringify(value, ...args);
        };
        result = resolveNativeAvailableProviders(source, consumers,
          [{ ref: "project", dependsOn: consumers.map((entry) => entry["bom-ref"]) }], { nativeProviderMetadata: manifest });
      } finally {
        JSON.stringify = stringify;
      }
      assert.equal(result.observedProviders, consumers.length);
      const refs = [];
      for (const [i, entry] of result.pkgList.entries()) {
        const props = Object.fromEntries(entry.properties.map(({ name, value }) => [name, value]));
        const evidence = props["cdx:native:providerEvidence"];
        const configurationId = hash(props["cdx:native:configurationContext"]);
        const identity = hash(stringify([configurationId, JSON.parse(evidence)]));
        assert.equal(props["cdx:native:providerIdentity"], identity);
        assert.equal(props["cdx:native:configuration"], configurationId);
        assert.equal(props["cdx:native:selection"], "available-not-selected");
        assert.ok(JSON.parse(props["cdx:native:providerExports"]).every((exp) => exp.interfaceVersionUnknown === true));
        const ref = `pkg:generic/scope-${i % 2}/shared-devel@2.7.4-3.fixture#available-native-${identity.slice(0, 20)}`;
        assert.equal(entry["bom-ref"], ref);
        refs.push(ref);
        const requirements = entry.properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
        assert.deepEqual(requirements.map((r) => r.line), [0, 1, 2, 3]);
        assert.ok(requirements.every((r) => r.file === `consumer-${i}/meson.build` &&
          r.providerCandidates.at(-1).ref === ref && r.providerCandidates.at(-1).selected === false));
      }
      assert.deepEqual(result.dependencies, [{ ref: "project", dependsOn: [...new Set(refs)] }]);
      assert.equal(evidenceSerializations, 1, "serialize each descriptor once, not once per requirement and consumer");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses concrete WrapDB recipe versions and exports, retaining constraints and multiple alternatives", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-cached-wrap-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const providers = [];
      for (const [version, revision] of [["2.7.4", 1], ["3.1.0", 2]]) {
        const path = `fixture-${version}.wrap`;
        const text = `[wrap-file]\nsource_url = https://example.invalid/fixture.tar.gz\nsource_hash = ${"a".repeat(64)}\nwrapdb_version = ${version}-${revision}\n[provide]\ndependency_names = cdx-fixture-provider\n`;
        writeFileSync(join(root, path), text);
        providers.push({ name: "fixture", metadata: { path, format: "wrap", sha256: createHash("sha256").update(text).digest("hex") } });
      }
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers }));
      const good = { ...requirement("cdx-fixture-provider", ">=2.0"), conditions: ["if optional_feature"] };
      const bad = { ...requirement("cdx-fixture-provider", ">=9.0"), line: 8 };
      const result = resolveNativeAvailableProviders(source, [component([good, bad])], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.deepEqual(result.pkgList.filter((p) => p.version).map((p) => p.version).sort(), ["2.7.4", "3.1.0"]);
      assert.equal(result.pkgList.filter((p) => !p.version).length, 1);
      for (const provider of result.pkgList.filter((p) => p.version)) {
        const r = JSON.parse(provider.properties.find((p) => p.name === "cdx:build:requirement").value);
        assert.deepEqual(r.conditions, ["if optional_feature"]);
        assert.equal(r.providerCandidates.at(-1).selected, false);
        assert.ok(provider.properties.some((p) => p.name === "cdx:native:selection" && p.value === "available-not-selected"));
      }
      const unrelatedAlias = { ...requirement("UnrelatedSDK", "", "find_package"), providerCandidates: [{ kind: "wrapdb-catalog", name: "fixture", selected: false }] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...component([unrelatedAlias]), name: "UnrelatedSDK" }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0, "unverified catalog labels must not authorize arbitrary aliases");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects filename-only recipe versions and unrelated or foreign-platform package exports", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-unsafe-cache-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const text = `[wrap-file]\ndirectory = fixture-99.0\nsource_url = https://example.invalid/fixture-99.0.tar.gz\nsource_hash = ${"a".repeat(64)}\n[provide]\ndependency_names = cdx-fixture-provider\n`;
      writeFileSync(join(root, "fixture.wrap"), text);
      const manifest = join(root, "providers.json");
      const entry = { name: "fixture", metadata: { path: "fixture.wrap", format: "wrap", sha256: createHash("sha256").update(text).digest("hex") } };
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [entry] }));
      assert.equal(resolveNativeAvailableProviders(source, [component([requirement("cdx-fixture-provider")])], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
      const rpm = JSON.stringify({ name: "unrelated", version: "2.0", release: "1", files: ["/usr/lib/pkgconfig/other.pc"] });
      writeFileSync(join(root, "rpm.json"), rpm);
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ platform: "win32", metadata: { path: "rpm.json", format: "rpm-json", sha256: createHash("sha256").update(rpm).digest("hex") } }] }));
      assert.equal(resolveNativeAvailableProviders(source, [component([requirement("cdx-fixture-provider")])], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("attributes thread capabilities to the real owning runtime, never a standalone threads release", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-thread-owner-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const text = JSON.stringify({ name: "glibc", version: "2.43", release: "9.fc44", files: ["/usr/lib64/libpthread.so.0"] });
      writeFileSync(join(root, "rpm.json"), text);
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ platform: "linux", metadata: { path: "rpm.json", format: "rpm-json", sha256: createHash("sha256").update(text).digest("hex") } }] }));
      const c = { ...component([requirement("threads")]), name: "threads" };
      const result = resolveNativeAvailableProviders(source, [c], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.equal(result.pkgList.find((p) => p.version)?.name, "glibc");
      assert.equal(result.pkgList.find((p) => p.version)?.version, "2.43-9.fc44");
      const dynamic = { ...requirement("Threads", "", "find_package"), arguments: ["Threads", "${QUIET_FLAG}", "${REQUIRED_FLAG}"] };
      const dynamicResult = resolveNativeAvailableProviders(source, [{ ...component([dynamic]), name: "Threads" }], [], { ...enabled, nativeProviderMetadata: manifest });
      assert.ok(dynamicResult.pkgList.some((entry) => entry.name === "glibc" && entry.version === "2.43-9.fc44"), "unknown diagnostic controls do not erase known runtime ownership");
      const windows = { ...requirement("threads"), conditions: ["if(WIN32)"] };
      assert.equal(resolveNativeAvailableProviders(source, [{ ...c, properties: component([windows]).properties }], [], { ...enabled, nativeProviderMetadata: manifest }).observedProviders, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
