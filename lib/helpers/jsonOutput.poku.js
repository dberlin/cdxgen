import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { runInNewContext } from "node:vm";

import { assert, describe, it } from "poku";

import { jsonOutputChunks, writeJsonToStream } from "./jsonOutput.js";

function output(value, pretty = false) {
  const chunks = [...jsonOutputChunks(value, pretty)];
  for (const chunk of chunks) {
    assert.strictEqual(typeof chunk, "string");
    assert.ok(chunk.length > 0 && chunk.length <= 64 * 1024);
  }
  return chunks.length ? chunks.join("") : undefined;
}

function assertMatchesNative(makeValue) {
  for (const pretty of [false, true]) {
    assert.strictEqual(
      output(makeValue(), pretty),
      JSON.stringify(makeValue(), null, pretty ? 2 : undefined),
    );
  }
}

function listenerCounts(stream) {
  return ["error", "close", "drain"].map((event) => stream.listenerCount(event));
}

describe("bounded JSON output", () => {
  it("matches native compact and pretty output for primitives and containers", () => {
    const values = [
      null,
      true,
      false,
      0,
      -0,
      1.25,
      1e30,
      NaN,
      Infinity,
      -Infinity,
      "already a string, not a raw JSON payload",
      undefined,
      () => {},
      Symbol("omitted"),
      [],
      {},
      {
        10: "ten",
        2: "two",
        nested: [null, { empty: {}, array: [] }, [true, -0, Infinity]],
        missing: undefined,
        method() {},
        symbol: Symbol("omitted"),
      },
    ];
    for (const value of values) {
      assertMatchesNative(() => value);
    }
  });

  it("preserves Unicode and lone surrogates across escaping and output boundaries", () => {
    const strings = [
      "\"\\\b\f\n\r\t\u0000\u001f/é漢字😀\u2028\u2029",
      "\ud800",
      "\udfff",
      "\ud800x\udfff",
      `${"x".repeat(4095)}😀${"y".repeat(65535)}😀\ud800`,
      "\u0000\n\"\\😀\ud800".repeat(25000),
    ];
    for (const value of strings) {
      assertMatchesNative(() => ({ [value]: [value] }));
      assert.strictEqual(
        Buffer.concat(
          [...jsonOutputChunks(value)].map((chunk) => Buffer.from(chunk)),
        ).toString(),
        JSON.stringify(value),
      );
    }
  });

  it("uses null for sparse and omitted array slots, including inherited entries", () => {
    assertMatchesNative(() => {
      const value = new Array(7);
      value[1] = undefined;
      value[2] = () => {};
      value[3] = Symbol("array value");
      value[5] = { omitted: undefined };
      Object.setPrototypeOf(value, { 4: "inherited" });
      value.extra = "not an array element";
      return value;
    });
  });

  it("calls toJSON with its holder key before deciding omission or boxing", () => {
    assertMatchesNative(() => {
      const callable = () => {};
      callable.toJSON = (key) => `function at ${key}`;
      callable.toJSON.call = () => {
        throw new Error("toJSON must use internal call semantics");
      };
      return {
        root: {
          toJSON(key) {
            assert.strictEqual(this.marker, "owned");
            return { key, callable };
          },
          marker: "owned",
        },
        missing: { toJSON: () => undefined },
        array: [{ toJSON: (key) => ({ key }) }],
        date: new Date("2025-01-01T00:00:00Z"),
        invalidDate: new Date(NaN),
        replaced: { toJSON: () => new Number(7) },
      };
    });
    assertMatchesNative(() => ({ toJSON: (key) => `root key:${key}` }));
    assertMatchesNative(() => {
      const value = new Number(3);
      value.toJSON = (key) => `boxed at ${key}`;
      return value;
    });
  });

  it("unboxes genuine primitive wrappers without trusting toStringTag", () => {
    assertMatchesNative(() => ({
      string: new String("text😀"),
      number: new Number(3),
      boolean: new Boolean(false),
      symbol: Object(Symbol("boxed")),
      spoofed: { [Symbol.toStringTag]: "Number", value: 7 },
      crossRealm: runInNewContext(
        '[new Number(4), new String("x"), new Boolean(true)]',
      ),
      proxy: new Proxy(new Number(8), {}),
    }));
    assertMatchesNative(() => {
      const value = new Number(3);
      value[Symbol.toPrimitive] = () => 12;
      return value;
    });
    assertMatchesNative(() => {
      const value = new Boolean(false);
      value.valueOf = () => true;
      return value;
    });
    const invalidNumber = new Number(1);
    invalidNumber[Symbol.toPrimitive] = () => 1n;
    assert.throws(() => output(invalidNumber), TypeError);
  });

  it("snapshots keys and array length but reads values in native order", () => {
    assertMatchesNative(() => {
      const value = {
        get first() {
          delete this.second;
          this.third = "too late";
          return "first";
        },
        second: "deleted",
      };
      return value;
    });
    assertMatchesNative(() => {
      const value = [0, 1, 2];
      Object.defineProperty(value, "0", {
        get() {
          value.length = 1;
          return "first";
        },
      });
      return value;
    });
    assertMatchesNative(
      () =>
        new Proxy([1, 2], {
          get(target, key, receiver) {
            return key === "length" ? 1.8 : Reflect.get(target, key, receiver);
          },
        }),
    );
  });

  it("serializes shared objects repeatedly but rejects actual ancestor cycles", () => {
    const shared = { name: "shared", nested: [1, 2] };
    assertMatchesNative(() => [shared, { shared }, shared]);
    const cyclic = { child: {} };
    cyclic.child.parent = cyclic;
    assert.throws(() => output(cyclic), TypeError);
    const cyclicArray = [];
    cyclicArray.push(cyclicArray);
    assert.throws(() => output(cyclicArray, true), TypeError);
    assertMatchesNative(() => {
      const value = {};
      value.self = value;
      value.toJSON = () => "cycle replaced";
      return value;
    });
  });

  it("rejects primitive and boxed BigInt and propagates user exceptions", () => {
    for (const value of [1n, Object(1n), { value: 1n }, [1n]]) {
      assert.throws(() => output(value), TypeError);
    }
    assertMatchesNative(() => {
      const value = Object(1n);
      value.toJSON = (key) => `bigint at ${key}`;
      return value;
    });
    const failure = new Error("getter failure");
    assert.throws(
      () =>
        output({
          get value() {
            throw failure;
          },
        }),
      (error) => error === failure,
    );
    assert.throws(
      () =>
        output({
          toJSON() {
            throw failure;
          },
        }),
      (error) => error === failure,
    );
  });

  it("supports native raw JSON when the runtime provides it", () => {
    if (typeof JSON.rawJSON === "function") {
      assertMatchesNative(() => ({ raw: JSON.rawJSON("12345678901234567890") }));
      const rawString = JSON.stringify(`${"x".repeat(4094)}😀`);
      assertMatchesNative(() => ({ raw: JSON.rawJSON(rawString) }));
      assert.strictEqual(
        Buffer.concat(
          [...jsonOutputChunks(JSON.rawJSON(rawString))].map((chunk) =>
            Buffer.from(chunk),
          ),
        ).toString(),
        rawString,
      );
    }
  });

  it("buffers small tokens and hashes a large composite without joining its output", () => {
    const value = { data: Array(1024).fill("é😀\n".repeat(1024)) };
    const actual = createHash("sha256");
    let count = 0;
    let length = 0;
    for (const chunk of jsonOutputChunks(value)) {
      assert.ok(chunk.length <= 64 * 1024);
      actual.update(chunk);
      length += chunk.length;
      count++;
    }
    const expected = createHash("sha256");
    expected.update('{"data":[');
    const item = JSON.stringify(value.data[0]);
    for (let index = 0; index < value.data.length; index++) {
      if (index) expected.update(",");
      expected.update(item);
    }
    expected.update("]}");
    assert.strictEqual(actual.digest("hex"), expected.digest("hex"));
    assert.ok(length > 4 * 1024 * 1024);
    assert.ok(count > 1 && count < 1024);
    const tokens = [...jsonOutputChunks(Array(100000).fill(0))];
    assert.ok(tokens.length < 10, "small tokens must not become separate writes");
  });

  it("handles deep nesting without recursive traversal or oversized indent tokens", () => {
    let value = null;
    for (let depth = 0; depth < 20000; depth++) value = [value];
    let size = 0;
    for (const chunk of jsonOutputChunks(value)) size += chunk.length;
    assert.strictEqual(size, 40004);
  });
});

describe("streaming JSON output", () => {
  it("waits for backpressure and writes complete UTF-8 without ending the stream", async () => {
    const chunks = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, encoding, callback) {
        setTimeout(() => {
          chunks.push(Buffer.from(chunk));
          callback();
        }, 1);
      },
    });
    const existingErrorListener = () => {};
    stream.on("error", existingErrorListener);
    const before = listenerCounts(stream);
    const value = { data: "😀\ud800\n".repeat(40000) };
    await writeJsonToStream(stream, value, true);
    assert.strictEqual(
      Buffer.concat(chunks).toString(),
      JSON.stringify(value, null, 2),
    );
    assert.strictEqual(stream.writableEnded, false);
    assert.deepStrictEqual(listenerCounts(stream), before);
    stream.removeListener("error", existingErrorListener);
    stream.end();
  });

  it("awaits accepted asynchronous writes even without backpressure", async () => {
    let written = "";
    const stream = new Writable({
      highWaterMark: 1024 * 1024,
      write(chunk, encoding, callback) {
        setTimeout(() => {
          written += chunk.toString();
          callback();
        }, 1);
      },
    });
    await writeJsonToStream(stream, { value: 1 });
    assert.strictEqual(written, '{"value":1}');
    assert.deepStrictEqual(listenerCounts(stream), [0, 0, 0]);
    stream.end();
  });

  it("rejects asynchronous write failures and removes temporary listeners", async () => {
    const failure = new Error("write failed");
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, encoding, callback) {
        setTimeout(() => callback(failure), 1);
      },
    });
    await assert.rejects(
      writeJsonToStream(stream, { value: 1 }),
      (error) => error === failure,
    );
    assert.deepStrictEqual(listenerCounts(stream), [0, 0, 0]);
  });

  it("propagates synchronous write exceptions without retaining listeners", async () => {
    const failure = new Error("synchronous write failed");
    const stream = new Writable({
      write() {
        throw failure;
      },
    });
    await assert.rejects(
      writeJsonToStream(stream, { value: 1 }),
      (error) => error === failure,
    );
    assert.deepStrictEqual(listenerCounts(stream), [0, 0, 0]);
    stream.destroy();
  });

  it("rejects premature close rather than waiting forever for drain", async () => {
    const stream = new Writable({
      highWaterMark: 1,
      write() {
        setTimeout(() => stream.destroy(), 1);
      },
    });
    await assert.rejects(writeJsonToStream(stream, { value: 1 }), /clos|destroy/i);
    assert.deepStrictEqual(listenerCounts(stream), [0, 0, 0]);
  });

  it("rejects finish during backpressure without requiring close", async () => {
    let completeWrite;
    const stream = new Writable({
      highWaterMark: 1,
      autoDestroy: false,
      write(chunk, encoding, callback) { completeWrite = callback; },
    });
    let outcome = "pending";
    const writing = writeJsonToStream(stream, { value: 1 }).then(
      () => { outcome = "resolved"; },
      () => { outcome = "rejected"; },
    );
    const finished = new Promise((resolve) => stream.once("finish", resolve));
    try {
      stream.end();
      completeWrite();
      await finished;
      await Promise.resolve();
      assert.strictEqual(outcome, "rejected");
      await writing;
      assert.strictEqual(stream.listenerCount("finish"), 0);
      assert.deepStrictEqual(listenerCounts(stream), [0, 0, 0]);
    } finally {
      stream.destroy();
    }
  });

  it("rejects streams that are already ended or destroyed", async () => {
    const ended = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    ended.end();
    await assert.rejects(writeJsonToStream(ended, {}), /clos|end|destroy/i);
    const destroyed = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    destroyed.destroy();
    await assert.rejects(writeJsonToStream(destroyed, {}), /clos|end|destroy/i);
    assert.deepStrictEqual(listenerCounts(ended), [0, 0, 0]);
    assert.deepStrictEqual(listenerCounts(destroyed), [0, 0, 0]);
  });

  it("propagates serialization failures without retaining listeners", async () => {
    const stream = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    await assert.rejects(writeJsonToStream(stream, { value: 1n }), TypeError);
    assert.deepStrictEqual(listenerCounts(stream), [0, 0, 0]);
    await writeJsonToStream(stream, undefined);
    assert.deepStrictEqual(listenerCounts(stream), [0, 0, 0]);
    stream.end();
  });
});
