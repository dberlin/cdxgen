import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assert, describe, it } from "poku";

import {
  getMaxWorkers,
  getWorkerThreshold,
  lastWorkerPoolSize,
  mapInWorkers,
  mapWithConcurrency,
} from "./parallel.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "cdxgen-parallel-poku-"));

process.on("exit", () => {
  rmSync(baseTempDir, { recursive: true, force: true });
});

/**
 * Write a worker entry module and return its URL. Fixtures are generated rather
 * than committed so that the shipped file list holds only runtime modules.
 *
 * @param {string} name File name to write under the temp dir.
 * @param {string} source Module source.
 * @returns {URL}
 */
const writeWorker = (name, source) => {
  const file = join(baseTempDir, name);
  writeFileSync(file, source, { encoding: "utf-8" });
  return pathToFileURL(file);
};

/** A worker that answers each task with its double. */
const doublingWorker = writeWorker(
  "doubling.js",
  [
    'import { parentPort } from "node:worker_threads";',
    "parentPort.on('message', (task) => {",
    "  parentPort.postMessage({ result: task * 2 });",
    "});",
  ].join("\n"),
);

/** A worker that ends the thread instead of replying. */
const exitingWorker = writeWorker(
  "exiting.js",
  [
    'import { parentPort } from "node:worker_threads";',
    'import process from "node:process";',
    "parentPort.on('message', () => {",
    "  process.exit(0);",
    "});",
  ].join("\n"),
);

/** A worker whose entry module cannot be resolved. */
const unloadableWorker = writeWorker(
  "unloadable.js",
  'import "./no-such-module.js";\n',
);

/** A worker that reports a per-task failure. */
const failingTaskWorker = writeWorker(
  "failing-task.js",
  [
    'import { parentPort } from "node:worker_threads";',
    "parentPort.on('message', (task) => {",
    "  if (task === 3) {",
    "    parentPort.postMessage({ error: 'task 3 refused' });",
    "  } else {",
    "    parentPort.postMessage({ result: task * 2 });",
    "  }",
    "});",
  ].join("\n"),
);

/** Real CPU work with shared counters, to evidence execution and its bound. */
const hashingWorker = writeWorker(
  "hashing.js",
  [
    'import { createHash } from "node:crypto";',
    'import { parentPort, threadId, isMainThread } from "node:worker_threads";',
    "parentPort.on('message', ({ value, counters }) => {",
    "  const counts = new Int32Array(counters);",
    "  const active = Atomics.add(counts, 0, 1) + 1;",
    "  let peak = Atomics.load(counts, 1);",
    "  while (active > peak) {",
    "    const previous = Atomics.compareExchange(counts, 1, peak, active);",
    "    if (previous === peak) break;",
    "    peak = previous;",
    "  }",
    "  const hash = createHash('sha256');",
    "  for (let i = 0; i < 2000; i++) hash.update(String(value));",
    "  Atomics.sub(counts, 0, 1);",
    "  Atomics.add(counts, 2 + value, 1);",
    "  parentPort.postMessage({ result: { hash: hash.digest('hex'), threadId, isMainThread } });",
    "});",
  ].join("\n"),
);

/** Complete one task before an infrastructure failure, without an error reply. */
const partiallyExitingWorker = writeWorker(
  "partially-exiting.js",
  [
    'import { parentPort } from "node:worker_threads";',
    "parentPort.on('message', (task) => {",
    "  if (task === 1) process.exit(0);",
    "  parentPort.postMessage({ result: task * 2 });",
    "});",
  ].join("\n"),
);

const range = (n) => Array.from({ length: n }, (_, i) => i);
const doubled = (n) => range(n).map((i) => i * 2);
const WORKER_TASKS = 40;

describe("mapWithConcurrency", async () => {
  await it("returns results in input order regardless of completion order", async () => {
    // Descending delays, so completion order is the reverse of input order.
    const items = [40, 30, 20, 10, 0];
    const results = await mapWithConcurrency(
      items,
      (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)),
      4,
    );
    assert.deepStrictEqual(results, items);
  });

  await it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      range(50),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
      4,
    );
    assert.strictEqual(peak, 4, `peak concurrency was ${peak}, expected 4`);
  });

  await it("propagates a rejection from the mapper", async () => {
    await assert.rejects(
      () =>
        mapWithConcurrency(range(10), (i) => {
          if (i === 5) {
            return Promise.reject(new Error("mapper failed"));
          }
          return Promise.resolve(i);
        }),
      /mapper failed/,
    );
  });
});

describe("mapInWorkers", async () => {
  await it("runs inline below the threshold and reports no workers", async () => {
    const tasks = range(4);
    const results = await mapInWorkers(
      doublingWorker,
      tasks,
      (task) => task * 2,
      { threshold: 24 },
    );
    assert.deepStrictEqual(results, doubled(4));
    assert.strictEqual(
      lastWorkerPoolSize(),
      0,
      "a batch below the threshold must report no workers, not the size of an earlier batch",
    );
  });

  await it("fans out to workers above the threshold, in input order", async () => {
    const results = await mapInWorkers(
      doublingWorker,
      range(WORKER_TASKS),
      () => {
        throw new Error("the inline path must not run for this batch");
      },
      { threshold: 24, maxWorkers: 4 },
    );
    assert.deepStrictEqual(results, doubled(WORKER_TASKS));
    assert.strictEqual(
      lastWorkerPoolSize(),
      4,
      `expected 4 workers, got ${lastWorkerPoolSize()}`,
    );
  });

  await it("reports no workers for an inline batch that follows a threaded one", async () => {
    await mapInWorkers(doublingWorker, range(WORKER_TASKS), (t) => t * 2, {
      threshold: 24,
      maxWorkers: 4,
    });
    assert.strictEqual(lastWorkerPoolSize(), 4);
    await mapInWorkers(doublingWorker, range(2), (t) => t * 2, {
      threshold: 24,
    });
    assert.strictEqual(
      lastWorkerPoolSize(),
      0,
      "a counter that outlives the call cannot evidence that any given call parallelised",
    );
  });

  await it("executes CPU work off-thread once per task within the configured bound", async () => {
    const counters = new SharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT * (WORKER_TASKS + 2),
    );
    const tasks = range(WORKER_TASKS).map((value) => ({ value, counters }));
    const results = await mapInWorkers(
      hashingWorker,
      tasks,
      () => {
        throw new Error("CPU work did not execute in a worker");
      },
      { threshold: 1, maxWorkers: 3 },
    );
    const threadIds = new Set();
    for (const [value, result] of results.entries()) {
      const hash = createHash("sha256");
      for (let i = 0; i < 2000; i++) hash.update(String(value));
      assert.strictEqual(result.hash, hash.digest("hex"));
      assert.strictEqual(result.isMainThread, false);
      assert.ok(result.threadId > 0);
      threadIds.add(result.threadId);
    }
    assert.ok(threadIds.size > 1, "one thread processed the entire CPU batch");
    assert.ok(threadIds.size <= 3);
    const counts = new Int32Array(counters);
    assert.strictEqual(counts[0], 0);
    assert.ok(counts[1] >= 1 && counts[1] <= 3);
    assert.deepStrictEqual(Array.from(counts.slice(2)), range(WORKER_TASKS).fill(1));
  });

  await it("reruns only unfinished tasks inline after a worker failure", async () => {
    const inlineTasks = [];
    const results = await mapInWorkers(
      partiallyExitingWorker,
      range(WORKER_TASKS),
      (task) => {
        inlineTasks.push(task);
        return task * 2;
      },
      { threshold: 1, maxWorkers: 1 },
    );
    assert.deepStrictEqual(results, doubled(WORKER_TASKS));
    assert.deepStrictEqual(inlineTasks, range(WORKER_TASKS).slice(1));
  });

  await it("preserves results when a task cannot be cloned into a worker", async () => {
    const tasks = [0, () => 1, 2];
    const inlineTasks = [];
    const results = await mapInWorkers(
      doublingWorker,
      tasks,
      (task) => {
        inlineTasks.push(task);
        return (typeof task === "function" ? task() : task) * 2;
      },
      { threshold: 1, maxWorkers: 1 },
    );
    assert.deepStrictEqual(results, [0, 2, 4]);
    assert.deepStrictEqual(inlineTasks, tasks.slice(1));
  });

  await it("keeps empty batches inline even when the threshold is zero", async () => {
    assert.deepStrictEqual(
      await mapInWorkers(doublingWorker, [], () => assert.fail("no tasks"), {
        threshold: 0,
      }),
      [],
    );
    assert.strictEqual(lastWorkerPoolSize(), 0);
  });

  await it("honors a finite integer bound for configured worker limits", async () => {
    for (const [maxWorkers, expected] of [
      [2.5, 2],
      [0, 1],
      [Number.NaN, getMaxWorkers()],
      [Number.POSITIVE_INFINITY, getMaxWorkers()],
    ]) {
      const results = await mapInWorkers(doublingWorker, range(WORKER_TASKS), (t) => t * 2, {
        threshold: 1,
        maxWorkers,
      });
      assert.deepStrictEqual(results, doubled(WORKER_TASKS));
      assert.strictEqual(lastWorkerPoolSize(), expected);
    }
  });

  await it("keeps unsupported runtimes inline independently of Bun support", () => {
    const moduleUrl = new URL("./parallel.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
      "globalThis.Deno = { version: { deno: 'test-runtime' } };",
      `const { mapInWorkers, lastWorkerPoolSize } = await import(${JSON.stringify(moduleUrl)});`,
      "const result = await mapInWorkers('unused-entry', [1,2,3], n => n * 2, { threshold: 1 });",
      "console.log(JSON.stringify({ result, workers: lastWorkerPoolSize() }));",
    ].join("\n")], { encoding: "utf-8", timeout: 10000 });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { result: [2, 4, 6], workers: 0 });
  });

  await it("completes every task inline when a worker exits without replying", async () => {
    // A worker can end without emitting `error`. Left unhandled the request
    // never settles and the scan hangs after the work is done.
    const results = await mapInWorkers(
      exitingWorker,
      range(WORKER_TASKS),
      (task) => task * 2,
      { threshold: 24, maxWorkers: 4 },
    );
    assert.deepStrictEqual(results, doubled(WORKER_TASKS));
  });

  await it("completes every task inline when the worker entry cannot load", async () => {
    // This is the shape a packaging mistake takes: the module resolves in a
    // checkout and not in a shipped build.
    const results = await mapInWorkers(
      unloadableWorker,
      range(WORKER_TASKS),
      (task) => task * 2,
      { threshold: 24, maxWorkers: 4 },
    );
    assert.deepStrictEqual(results, doubled(WORKER_TASKS));
  });

  await it("completes every task inline when no worker can be constructed", async () => {
    const results = await mapInWorkers(
      "not-a-usable-worker-specifier",
      range(WORKER_TASKS),
      (task) => task * 2,
      { threshold: 24, maxWorkers: 4 },
    );
    assert.deepStrictEqual(results, doubled(WORKER_TASKS));
  });

  await it("swallows a single failing task without abandoning the rest", async () => {
    const results = await mapInWorkers(
      failingTaskWorker,
      range(WORKER_TASKS),
      (task) => task * 2,
      {
        threshold: 24,
        maxWorkers: 4,
        swallowErrors: true,
        errorResult: null,
      },
    );
    const expected = doubled(WORKER_TASKS);
    expected[3] = null;
    assert.deepStrictEqual(results, expected);
  });

  await it("rejects on a failing task when errors are not swallowed", async () => {
    await assert.rejects(
      () =>
        mapInWorkers(failingTaskWorker, range(WORKER_TASKS), (t) => t * 2, {
          threshold: 24,
          maxWorkers: 4,
        }),
      /task 3 refused/,
    );
  });

  await it("exposes a threshold above one, so trivial batches stay inline", async () => {
    assert.ok(
      getWorkerThreshold() > 1,
      "a threshold of 1 would pay worker startup for a single-file project",
    );
  });
});
