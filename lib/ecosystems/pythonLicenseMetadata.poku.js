import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { strict as assert, describe, test } from "poku";

import { pythonLicenseIdentity } from "./pythonLicenseMetadata.js";

describe("Python license ownership", () => {
  test("attributes dist-info/licenses to METADATA, not the licenses directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-license-owner-"));
    try {
      const dist = join(root, "demo-2.3.4.dist-info");
      const license = join(dist, "licenses", "LICENSE");
      mkdirSync(dirname(license), { recursive: true });
      writeFileSync(license, "MIT license text is not version evidence");
      writeFileSync(join(dist, "METADATA"), "Metadata-Version: 2.4\nName: Demo_Package\nVersion: 2.3.4\n\n");
      const identity = pythonLicenseIdentity(license);
      assert.equal(identity.name, "demo-package");
      assert.equal(identity.version, "2.3.4");
      assert.equal(identity.source, join(dist, "METADATA"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("a copied vendor license and its source use the same exact vendor pin", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-vendor-owner-"));
    try {
      const vendor = join(root, "pip", "_vendor");
      mkdirSync(join(vendor, "requests"), { recursive: true });
      writeFileSync(join(vendor, "vendor.txt"), "requests==2.32.5\n");
      const original = pythonLicenseIdentity(join(vendor, "requests", "LICENSE"));
      const copy = pythonLicenseIdentity(join(root, "pip-26.2.dist-info", "licenses", "src", "pip", "_vendor", "requests", "LICENSE"));
      assert.deepEqual(original, copy);
      assert.equal(copy.version, "2.32.5");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
