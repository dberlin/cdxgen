#!/usr/bin/env node
import { parseArgs } from "node:util";

import {
  captureCmakeDependencyFacts,
  captureMesonDependencyFacts,
} from "../lib/ecosystems/nativeDependencyCapture.js";

const separator = process.argv.indexOf("--");
const { values } = parseArgs({
  args: process.argv.slice(2, separator < 0 ? undefined : separator),
  options: {
    tool: { type: "string" },
    source: { type: "string" },
    build: { type: "string" },
    output: { type: "string" },
  },
  strict: true,
});
if (
  !["cmake", "meson"].includes(values.tool) ||
  !values.source ||
  !values.build ||
  !values.output
) {
  console.error(
    "Usage: node bin/native-dependency-capture.js --tool cmake|meson --source SOURCE --build EMPTY_EXTERNAL_BUILD --output FACTS.json [-- CONFIGURE_ARGUMENTS...]",
  );
  process.exitCode = 1;
} else {
  try {
    const capture =
      values.tool === "cmake"
        ? captureCmakeDependencyFacts
        : captureMesonDependencyFacts;
    const facts = capture({
      sourceRoot: values.source,
      buildRoot: values.build,
      output: values.output,
      configureArgs: separator < 0 ? [] : process.argv.slice(separator + 1),
    });
    console.log(
      `Captured ${facts.records.length} native dependency observations (${facts.configuration.id}).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
