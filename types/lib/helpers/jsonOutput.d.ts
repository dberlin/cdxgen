import type { Writable } from "node:stream";

/** Serializes JSON in bounded chunks without assembling the whole document. */
export declare function jsonOutputChunks(value: unknown, pretty?: boolean): Generator<string, void, unknown>;

/** Writes JSON with backpressure without closing the destination stream. */
export declare function writeJsonToStream(stream: Writable, value: unknown, pretty?: boolean): Promise<void>;
