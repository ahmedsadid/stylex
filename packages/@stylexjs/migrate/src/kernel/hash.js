/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import crypto from 'crypto';

/**
 * Content hashing for the candidate boundary.
 *
 * Every identity in the kernel is derived from content, never from a counter or
 * a timestamp: two runs that produce the same bytes must produce the same
 * candidate id, and one changed byte must produce a different one. That is what
 * lets evidence be bound to an exact patch.
 */

export const HASH_ALGORITHM: string = 'sha256';

const FIELD_SEPARATOR = String.fromCharCode(0);

export function hashString(input: string): string {
  return crypto.createHash(HASH_ALGORITHM).update(input, 'utf8').digest('hex');
}

/**
 * Hash an ordered list of fields with a separator that cannot occur in a path
 * or a hash, so ['a', 'bc'] and ['ab', 'c'] cannot collide.
 */
export function hashFields(fields: $ReadOnlyArray<string>): string {
  return hashString(fields.join(FIELD_SEPARATOR));
}

/**
 * Short form for display and for candidate ids. Truncation is safe here because
 * ids are compared against a set the kernel itself produced, never used as a
 * security boundary.
 */
export function shortHash(hash: string): string {
  return hash.slice(0, 16);
}
