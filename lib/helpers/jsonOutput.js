import { types } from "node:util";

const CHUNK_LENGTH = 64 * 1024;
// Even a piece consisting entirely of escaped control characters stays bounded.
const STRING_PIECE_LENGTH = 4096;

function isOmitted(value) {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

// Follow JSON.stringify's toJSON and wrapper conversion order. Internal-slot
// checks also recognize cross-realm wrappers without accepting toStringTag spoofs.
function jsonValue(value, key) {
  if (
    value !== null &&
    (typeof value === "object" ||
      typeof value === "function" ||
      typeof value === "bigint")
  ) {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key]);
  }
  if (value !== null && typeof value === "object") {
    if (types.isNumberObject(value)) return +value;
    if (types.isStringObject(value)) return String(value);
    if (types.isBooleanObject(value)) {
      return Boolean.prototype.valueOf.call(value);
    }
    if (types.isBigIntObject(value)) {
      return BigInt.prototype.valueOf.call(value);
    }
  }
  return value;
}

function stringPieceEnd(value, start) {
  let end = Math.min(start + STRING_PIECE_LENGTH, value.length);
  // Native stringify must see both halves together, or it would escape a
  // valid pair as two lone surrogates and change the exact JSON bytes.
  if (
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end--;
  }
  return end;
}

function* quotedString(value) {
  if (value.length <= STRING_PIECE_LENGTH) {
    yield JSON.stringify(value);
    return;
  }
  yield '"';
  for (let start = 0; start < value.length; ) {
    const end = stringPieceEnd(value, start);
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

function* indentation(depth) {
  let remaining = depth * 2;
  while (remaining > 0) {
    const length = Math.min(remaining, CHUNK_LENGTH);
    yield " ".repeat(length);
    remaining -= length;
  }
}

function arrayLength(value) {
  // Arrays themselves have integral lengths, but a Proxy can intercept length.
  const length = +value.length;
  if (Number.isNaN(length) || length <= 0) return 0;
  return Math.min(Math.floor(length), Number.MAX_SAFE_INTEGER);
}

function* jsonTokens(value, pretty) {
  let current = jsonValue(value, "");
  if (isOmitted(current)) return;
  const ancestors = new Set();
  const stack = [];

  while (true) {
    if (typeof current === "string") {
      yield* quotedString(current);
    } else if (typeof current === "bigint") {
      throw new TypeError("Do not know how to serialize a BigInt");
    } else if (current === null || typeof current !== "object") {
      yield JSON.stringify(current);
    } else if (typeof JSON.isRawJSON === "function" && JSON.isRawJSON(current)) {
      // Native raw JSON is already encoded; do not quote or reinterpret it.
      const raw = current.rawJSON;
      for (let start = 0; start < raw.length; ) {
        const end = stringPieceEnd(raw, start);
        yield raw.slice(start, end);
        start = end;
      }
    } else {
      if (ancestors.has(current)) {
        throw new TypeError("Converting circular structure to JSON");
      }
      const array = Array.isArray(current);
      const keys = array ? null : Object.keys(current);
      stack.push({
        value: current,
        array,
        keys,
        length: array ? arrayLength(current) : keys.length,
        index: 0,
        written: false,
      });
      ancestors.add(current);
      yield array ? "[" : "{";
    }

    // Walk explicitly rather than recursing through the BOM. Key snapshots and
    // array lengths match native JSON.stringify; property values remain lazy.
    let found = false;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      while (frame.index < frame.length) {
        const key = frame.array
          ? String(frame.index++)
          : frame.keys[frame.index++];
        current = jsonValue(frame.value[key], key);
        if (isOmitted(current)) {
          if (!frame.array) continue;
          current = null;
        }
        if (frame.written) yield ",";
        if (pretty) {
          yield "\n";
          yield* indentation(stack.length);
        }
        if (!frame.array) {
          yield* quotedString(key);
          yield pretty ? ": " : ":";
        }
        frame.written = true;
        found = true;
        break;
      }
      if (found) break;
      if (frame.written && pretty) {
        yield "\n";
        yield* indentation(stack.length - 1);
      }
      yield frame.array ? "]" : "}";
      stack.pop();
      ancestors.delete(frame.value);
    }
    if (!found) return;
  }
}

/**
 * Serialize JSON without creating a string for the complete document or any
 * complete container. Chunks contain at most 64 Ki UTF-16 code units, and never
 * split a Unicode surrogate pair. Memory is bounded by the current chunk,
 * traversal depth, and key snapshots of the objects currently being traversed.
 *
 * Like JSON.stringify, an omitted top-level value produces no output; strings
 * are JSON-quoted, not treated as pre-serialized payloads. Pretty output uses
 * two spaces and has no trailing newline. Serialization errors may follow
 * earlier chunks, so file callers should use an atomic chunked writer.
 *
 * @param {*} value Value to serialize.
 * @param {boolean} [pretty=false] Whether to indent by two spaces.
 * @returns {Generator<string>} Bounded JSON chunks.
 */
export function* jsonOutputChunks(value, pretty = false) {
  let pieces = [];
  let length = 0;
  for (const token of jsonTokens(value, pretty)) {
    if (length + token.length > CHUNK_LENGTH) {
      yield pieces.join("");
      pieces = [];
      length = 0;
    }
    pieces.push(token);
    length += token.length;
  }
  if (length) yield pieces.join("");
}

/**
 * Write bounded JSON to an existing Node-compatible writable stream, waiting
 * for both write completion and backpressure. Does not end or destroy the
 * caller-owned stream, and removes its listeners on success or failure.
 *
 * @param {import("node:stream").Writable} stream Destination, such as stdout.
 * @param {*} value Value to serialize.
 * @param {boolean} [pretty=false] Whether to indent by two spaces.
 * @returns {Promise<void>} Resolves after all chunks have been written.
 */
export async function writeJsonToStream(stream, value, pretty = false) {
  let pending;
  let failure;
  const closedError = () =>
    stream.errored ||
    new Error("JSON output stream closed or ended before writing completed");
  const checkStream = () => {
    if (failure) throw failure;
    if (stream.destroyed || stream.writableEnded || stream.writable === false) {
      throw closedError();
    }
  };
  const settle = (state) => {
    if (pending === state && state.returned && state.completed && state.drained) {
      pending = undefined;
      state.resolve();
    }
  };
  const onError = (error) => {
    failure ||= error;
    if (pending) {
      const state = pending;
      pending = undefined;
      state.reject(failure);
    }
  };
  const onClose = () => onError(closedError());
  const onDrain = () => {
    if (pending) {
      pending.drained = true;
      settle(pending);
    }
  };

  checkStream();
  stream.on("error", onError);
  stream.on("close", onClose);
  stream.on("finish", onClose);
  stream.on("drain", onDrain);
  try {
    for (const chunk of jsonOutputChunks(value, pretty)) {
      checkStream();
      await new Promise((resolve, reject) => {
        const state = {
          resolve,
          reject,
          returned: false,
          completed: false,
          drained: false,
        };
        pending = state;
        const accepted = stream.write(chunk, (error) => {
          if (error) {
            onError(error);
            return;
          }
          state.completed = true;
          settle(state);
        });
        state.returned = true;
        if (accepted) state.drained = true;
        settle(state);
      });
    }
    if (failure) throw failure;
  } finally {
    pending = undefined;
    stream.removeListener("error", onError);
    stream.removeListener("close", onClose);
    stream.removeListener("finish", onClose);
    stream.removeListener("drain", onDrain);
  }
}
