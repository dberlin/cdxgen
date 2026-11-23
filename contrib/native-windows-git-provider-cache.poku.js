import { assert, describe, it } from "poku";

import { windowsGitReleaseAsset } from "./native-windows-git-provider-cache.js";

describe("actual Windows Git package releases", () => {
  it("uses a concrete release version and hash-identified matching package, never an arbitrary filename version", () => {
    const release = { tag_name: "v2.56.0.windows.4", draft: false, prerelease: false,
      assets: [{ name: "MinGit-2.56.0.4-64-bit.zip", size: 1234, digest: `sha256:${"a".repeat(64)}` }] };
    assert.equal(windowsGitReleaseAsset(release).version, "2.56.0.windows.4");
    assert.equal(windowsGitReleaseAsset({ ...release, tag_name: "latest" }), undefined);
    assert.equal(windowsGitReleaseAsset({ ...release, assets: [{ ...release.assets[0], name: "MinGit-99.0-64-bit.zip" }] }), undefined);
    assert.equal(windowsGitReleaseAsset({ ...release, assets: [{ ...release.assets[0], digest: undefined }] }), undefined);
  });
});
