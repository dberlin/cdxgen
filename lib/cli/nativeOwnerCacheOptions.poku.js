import { strict as assert, test } from "poku";
import { applyOperatorToolingChoice } from "./cliOptions.js";
import { sanitizeProjectConfig } from "../core/projectConfig.js";
import * as ownerCache from "../ecosystems/nativeOwnerCache.js";

test("owner cache is an explicit argv-only immutable scan choice", () => {
  const flag = "--native-owner-evaluation-cache";
  const root = "/operator/cache";
  const env = { CDXGEN_NATIVE_OWNER_EVALUATION_CACHE: root, CDXGEN_IMMUTABLE_SOURCE: "true" };
  assert.equal(typeof ownerCache.nativeOwnerCacheDirectory, "symbol");
  const pick = (argv, options = {}) => {
    applyOperatorToolingChoice(options, { argv, env, isSecureMode: false });
    return options[ownerCache.nativeOwnerCacheDirectory];
  };
  assert.equal(pick(["--immutable-source"]), undefined);
  assert.equal(pick([flag, root]), undefined);
  assert.equal(pick(["--immutable-source", "--", flag, root]), undefined);
  assert.equal(pick(["--immutable-source", flag, root, "--no-cache"]), undefined);
  assert.equal(pick(["--immutable-source", flag, "--", flag, root]), undefined);
  assert.equal(pick(["--immutable-source", flag, root], { server: true }), undefined);
  assert.equal(pick(["--immutable-source", flag, root]), root);
});

test("project configuration cannot choose a native owner cache directory", () => {
  const spellings = ["native-owner-evaluation-cache", "nativeOwnerEvaluationCache", "native_owner_evaluation_cache"];
  const projectConfig = Object.fromEntries(spellings.map((spelling) => [spelling, "/project/cache"]));
  const { config, rejected } = sanitizeProjectConfig(projectConfig, "/project");
  assert.deepEqual(config, {});
  assert.deepEqual(new Set(rejected), new Set(spellings));
});
