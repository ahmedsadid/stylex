/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { JsonValue } from './json';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /authorization|cookie|credential|password|secret|token|api.?key/i;

/** Redact structured command output before it reaches logs or JSON output. */
export function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value != null && typeof value === 'object') {
    const output: { [string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(value[key]);
    }
    return output;
  }
  return value;
}

export function redactText(input: string): string {
  return input
    .replace(
      /([?&](?:access_token|token|key|secret)=)[^&\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`);
}
