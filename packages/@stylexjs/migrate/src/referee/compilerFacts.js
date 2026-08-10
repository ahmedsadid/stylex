/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { compileStyleX } from '../evidence/compile';
import { packageVersion } from '../evidence/claims';
import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import type { CompiledStyleXRule } from '../evidence/compile';

export const COMPILER_FACTS_MODEL: string = 'stylex-compiler-facts-v1';
export const STYLEX_COMPILER_PROVIDER: string = '@stylexjs/babel-plugin';

export type CompilerProbe = {
  +id: string,
  +filename: string,
  +source: string,
};

export type ObservedCompilerProbe = {
  +id: string,
  +filename: string,
  +source: string,
  +sourceHash: string,
  +compiledCode: string,
  +rules: $ReadOnlyArray<CompiledStyleXRule>,
};

export type StyleXCompilerFacts = {
  +id: string,
  +model: string,
  +provider: string,
  +providerVersion: string,
  +probes: $ReadOnlyArray<ObservedCompilerProbe>,
};

/**
 * Observe StyleX rather than reproducing its priority table.
 *
 * The committed golden fixture built from this result is a compatibility
 * alarm. A StyleX upgrade that changes a selector, class hash, normalized
 * value, or priority must update the fixture and trigger a referee review.
 */
export function observeStyleXCompiler(
  probes: $ReadOnlyArray<CompilerProbe>,
): StyleXCompilerFacts {
  if (probes.length === 0) {
    throw new Error('StyleX compiler facts require at least one probe');
  }
  const ids = new Set<string>();
  const observed = probes.map((probe) => {
    if (
      probe.id === '' ||
      probe.filename === '' ||
      probe.source === '' ||
      ids.has(probe.id)
    ) {
      throw new Error('Invalid StyleX compiler fact probe');
    }
    ids.add(probe.id);
    const compiled = compileStyleX(probe.source, probe.filename);
    if (!compiled.ok) {
      throw new Error(`StyleX probe ${probe.id} failed: ${compiled.reason}`);
    }
    return Object.freeze({
      ...probe,
      sourceHash: hashString(probe.source),
      compiledCode: compiled.code,
      rules: compiled.ruleMetadata,
    });
  });
  const stable = {
    model: COMPILER_FACTS_MODEL,
    provider: STYLEX_COMPILER_PROVIDER,
    providerVersion: packageVersion(STYLEX_COMPILER_PROVIDER),
    probes: Object.freeze(observed),
  };
  return Object.freeze({
    id: shortHash(hashString(canonicalJson(stable as $FlowFixMe))),
    ...stable,
  });
}
