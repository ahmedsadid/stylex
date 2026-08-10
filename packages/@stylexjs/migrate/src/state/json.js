/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | $ReadOnlyArray<JsonValue>
  | { +[string]: JsonValue };

export type AtomicWriteIO = {
  +renameSync: (source: string, destination: string) => void,
};

const defaultAtomicWriteIO: AtomicWriteIO = Object.freeze({
  renameSync: fs.renameSync,
});

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value != null && typeof value === 'object') {
    const output: { [string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = normalize(value[key]);
    }
    return output;
  }
  return value;
}

export function immutableJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(immutableJson));
  }
  if (value != null && typeof value === 'object') {
    const output: { [string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      output[key] = immutableJson(value[key]);
    }
    return Object.freeze(output);
  }
  return value;
}

/** Stable bytes for identities and integrity checks. */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value));
}

export function parseJson(text: string, source: string): JsonValue {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Write one file by replacing it with a fully written sibling.
 *
 * The existing destination is never truncated. If writing or replacement
 * fails, the previous record remains intact and the temporary is removed.
 */
export function writeFileAtomic(
  destination: string,
  contents: string | Buffer,
  options?: {
    +io?: AtomicWriteIO,
    +mode?: number,
  },
): void {
  const io = options?.io ?? defaultAtomicWriteIO;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto
      .randomBytes(12)
      .toString('hex')}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', options?.mode ?? 0o600);
    let bytes: Buffer;
    if (typeof contents === 'string') {
      bytes = Buffer.from(contents, 'utf8');
    } else {
      bytes = contents;
    }
    fs.writeSync(descriptor, bytes, 0, bytes.length);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    io.renameSync(temporary, destination);
  } catch (error) {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(
  destination: string,
  value: JsonValue,
  options?: { +io?: AtomicWriteIO },
): void {
  writeFileAtomic(destination, `${canonicalJson(value)}\n`, options);
}
