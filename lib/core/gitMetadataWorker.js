import { spawnSync } from "node:child_process";
import { parentPort } from "node:worker_threads";

function errorFields(error) {
  return { ...error, name: error.name, message: error.message, stack: error.stack };
}

// The parent performs every policy/argument check, then sends only the
// prepared read-only Git invocation. Use the same process API as the serial
// path: timeout, maxBuffer, exit status, signal and output encoding all match.
parentPort.on("message", ([command, args, options]) => {
  try {
    const result = spawnSync(command, args, options);
    if (result.error) result.error = errorFields(result.error);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ exception: errorFields(error) });
  }
});
parentPort.postMessage({ ready: true });
