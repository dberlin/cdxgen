import { assert, describe, it } from "poku";

import { nativeProviderArtifactUrls } from "./native-provider-artifacts.js";

describe("verified provider source metadata", () => {
  it("constructs only literal recipe-bound source URLs, not versions inferred from package names", () => {
    assert.deepEqual(nativeProviderArtifactUrls({ command: "vcpkg_from_github", arguments: ["REPO", "owner/fixture", "REF", "v4.2.1"], revision: "v4.2.1" }), ["https://github.com/owner/fixture/archive/v4.2.1.tar.gz"]);
    assert.deepEqual(nativeProviderArtifactUrls({ command: "vcpkg_from_github", arguments: ["REPO", "owner/fixture", "REF", "${UNKNOWN}"], revision: "${UNKNOWN}" }), []);
    assert.deepEqual(nativeProviderArtifactUrls({ command: "vcpkg_from_sourceforge", arguments: ["REPO", "half/half", "FILENAME", "half-2.2.1.zip"], revision: "2.2.1" }), ["https://sourceforge.net/projects/half/files/half/2.2.1/half-2.2.1.zip/download"]);
  });
});
