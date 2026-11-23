import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strict as assert, test } from "poku";
import { nativeOwnedSourceVersionCandidates, reconcileCmakeSourceProjects } from "./nativeSourceVersions.js";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-owned-release-"));
  const put = (path, text) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  try { run(root, put); } finally { rmSync(root, { recursive: true, force: true }); }
}
function source(name, dir) {
  const version = "1".repeat(40);
  const ref = `pkg:generic/${name}@${version}#${dir}`;
  return { name, version, purl: ref, "bom-ref": ref, properties: [{ name: "cdx:version:kind", value: "source-revision" }, { name: "cdx:cmake:sourceDir", value: dir }] };
}
function request(name) {
  return { name, "bom-ref": `request-${name}`, properties: [{ name: "cdx:build:requirement", value: JSON.stringify({ id: name, role: "software", requestedName: name, file: "consumer/CMakeLists.txt", conditions: [], providerCandidates: [] }) }] };
}

test("owned release replaces revision identity while preserving revision and graph provenance", () => fixture((root, put) => {
  put("sdk/VERSION", "1.5.0\n");
  put("sdk/CMakeLists.txt", "project(sdk)\n");
  const project = source("sdk", "sdk");
  const old = project["bom-ref"];
  const result = reconcileCmakeSourceProjects([project], [project], [{ ref: "root", dependsOn: [old] }, { ref: old, dependsOn: ["external"] }], root);
  assert.equal(project.version, "1.5.0");
  assert.ok(project.purl.includes("@1.5.0#sdk"));
  assert.ok(project.properties.some((p) => p.name === "cdx:version:sourceRevision" && p.value === "1".repeat(40)));
  assert.ok(project.properties.some((p) => p.name === "cdx:version:sourceIdentity" && p.value === old));
  assert.deepEqual(result.dependencies, [{ ref: "root", dependsOn: [project["bom-ref"]] }, { ref: project["bom-ref"], dependsOn: ["external"] }]);
}));

test("exported package alternatives become actual versioned components without selecting either copy", () => fixture((root, put) => {
  for (const [dir, version] of [["one", "3.0.0"], ["two", "2.0.0"]]) {
    put(`${dir}/VERSION`, `${version}\n`);
    put(`${dir}/CMakeLists.txt`, "project(threads)\nconfigure_package_config_file(PTLConfig.cmake.in ${CMAKE_CURRENT_BINARY_DIR}/PTLConfig.cmake INSTALL_DESTINATION lib/cmake/PTL)\n");
  }
  const projects = [source("threads", "one"), source("threads", "two")];
  const requirement = request("PTL");
  const result = reconcileCmakeSourceProjects([requirement], projects, [{ ref: "root", dependsOn: [requirement["bom-ref"]] }], root);
  assert.equal(result.pkgList.length, 2);
  assert.deepEqual(result.pkgList.map((c) => c.version).sort(), ["2.0.0", "3.0.0"]);
  assert.equal(new Set(result.pkgList.map((c) => c["bom-ref"])).size, 2);
  assert.deepEqual(new Set(result.dependencies[0].dependsOn), new Set(result.pkgList.map((c) => c["bom-ref"])));
  for (const component of result.pkgList) {
    assert.equal(component.name, "PTL");
    const record = JSON.parse(component.properties.find((p) => p.name === "cdx:build:requirement").value);
    assert.ok(record.providerCandidates.length === 2 && record.providerCandidates.every((c) => c.selected === false));
    assert.ok(component.properties.some((p) => p.name === "cdx:cmake:resolvedVia" && p.value === "source-candidate"));
  }
}));

test("same names without export evidence and conditional packaging defaults do not resolve consumers", () => fixture((root, put) => {
  put("one/CMakeLists.txt", "project(owned)\nif(NOT DEFINED owned_RELEASE_VERSION)\nset(owned_RELEASE_VERSION 99.0 CACHE STRING version)\nendif()\n");
  put("two/CMakeLists.txt", "project(unexported)\n");
  put("two/VERSION", "3.0.0\n");
  const projects = [source("owned", "one"), source("unexported", "two")];
  const requirements = [request("owned"), request("unexported")];
  const result = reconcileCmakeSourceProjects(requirements, projects, [], root);
  assert.equal(projects[0].version, "1".repeat(40));
  assert.deepEqual(result.pkgList, requirements);
}));

test("explicit standalone VERSION owner materializes a release candidate, bare VERSION does not", () => fixture((root, put) => {
  put("hip/VERSION", "#HIP_VERSION_MAJOR\n7\n#HIP_VERSION_MINOR\n18\n#HIP_VERSION_PATCH\n0\n");
  put("bare/VERSION", "99.0.0\n");
  const properties = ["hip", "bare"].flatMap((dir) => nativeOwnedSourceVersionCandidates(undefined, join(root, dir), root)).map((c) => ({ name: "cdx:cmake:versionCandidate", value: JSON.stringify(c) }));
  const result = reconcileCmakeSourceProjects([request("HIP"), request("bare")], [], [], root, properties);
  assert.ok(result.pkgList.some((c) => c.name === "HIP" && c.version === "7.18.0"));
  assert.ok(result.pkgList.some((c) => c.name === "bare" && !c.version));
}));

test("a conflicting explicit project release is never overwritten by VERSION metadata", () => fixture((root, put) => {
  put("one/CMakeLists.txt", "project(owned VERSION 1.0.0)\n");
  put("one/VERSION", "2.0.0\n");
  const project = { ...source("owned", "one"), version: "1.0.0", properties: [{ name: "cdx:cmake:sourceDir", value: "one" }] };
  reconcileCmakeSourceProjects([], [project], [], root);
  assert.equal(project.version, "1.0.0");
}));

test("configuration template names are not package exports when the generated name differs", () => fixture((root, put) => {
  put("sdk/CMakeLists.txt", "project(sdk VERSION 1.5.0)\nconfigure_package_config_file(cmake/FooConfig.cmake.in ${CMAKE_CURRENT_BINARY_DIR}/BarConfig.cmake INSTALL_DESTINATION lib/cmake/Bar)\nconfigure_file(cmake/OtherConfig.cmake.in ${CMAKE_CURRENT_BINARY_DIR}/ActualConfig.cmake @ONLY)\n");
  const result = reconcileCmakeSourceProjects(["Foo", "Bar", "Other", "Actual"].map(request),
    [source("sdk", "sdk")], [], root);
  for (const name of ["Foo", "Other"]) assert.ok(result.pkgList.some((component) => component.name === name && !component.version));
  for (const name of ["Bar", "Actual"]) {
    const component = result.pkgList.find((component) => component.name === name);
    assert.equal(component.version, "1.5.0");
    assert.ok(component.properties.some((property) => property.name === "cdx:cmake:packageExport"));
  }
}));
