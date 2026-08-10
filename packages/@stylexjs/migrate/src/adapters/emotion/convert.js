/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { parseSource } from '../../static/parse';
import {
  resolveModuleBinding,
  freeName,
  collectUsedNames,
} from '../../static/bindings';
import {
  STYLEX_MODULE,
  allocateKeys,
  emitCreateCall,
  emitImport,
  emitPropsSpread,
} from '../../static/emit';
import { applyEdits } from '../../static/rewrite';
import { discover } from './discover';
import type { Edit } from '../../static/rewrite';
import type { EmotionRefusal, EmotionSite } from './discover';
import type { StyleObject } from '../../static/ir';

/**
 * The mechanical proposal for one Emotion file.
 *
 * This module produces a *proposal* only. It carries no claim about the CSS it
 * produced — establishing that is the evidence engine's job, and the entry
 * point that runs those checks is the only one exported for general use.
 *
 * Note what it deliberately does not do: it leaves the `@emotion/react` import
 * and the JSX pragma alone. Deciding a module no longer needs its styling
 * library is a whole-file question (other sites may be refused, `css` may be
 * used elsewhere), and getting it wrong breaks the build. Cleanup arrives with
 * the adapter's cleanup-eligibility rules in a later milestone.
 */

export type ConvertedEntry = {
  +key: string,
  +style: StyleObject,
  +site: EmotionSite,
};

export type ConvertedOutcome = {
  +status: 'converted',
  +code: string,
  +entries: $ReadOnlyArray<ConvertedEntry>,
  +registryName: string,
  +namespace: string,
  +refusals: $ReadOnlyArray<EmotionRefusal>,
};

export type ConversionOutcome =
  | ConvertedOutcome
  | {
      +status: 'unchanged',
      +reason: 'not-emotion' | 'no-supported-sites',
      +refusals: $ReadOnlyArray<EmotionRefusal>,
    }
  | { +status: 'refused', +reason: string };

function registryOffsetFor(ast: $FlowFixMe, siteStart: number): number | null {
  for (const statement of ast.program?.body ?? []) {
    if (statement.start <= siteStart && siteStart < statement.end) {
      return statement.start;
    }
  }
  return null;
}

export function convertSource(
  source: string,
  filename: string,
): ConversionOutcome {
  const parsed = parseSource(source, filename);
  if (!parsed.ok) {
    return { status: 'refused', reason: parsed.reason };
  }
  const ast = parsed.ast;
  const discovered = discover(ast);

  if (!discovered.usesEmotion) {
    return {
      status: 'unchanged',
      reason: 'not-emotion',
      refusals: discovered.refusals,
    };
  }
  if (discovered.sites.length === 0) {
    return {
      status: 'unchanged',
      reason: 'no-supported-sites',
      refusals: discovered.refusals,
    };
  }

  const binding = resolveModuleBinding(ast, STYLEX_MODULE, 'stylex');
  const used = collectUsedNames(ast);
  const registryName = freeName('styles', used);

  const keys = allocateKeys(discovered.sites.map((site) => site.elementName));
  const entries: $ReadOnlyArray<ConvertedEntry> = discovered.sites.map(
    (site, index) => ({ key: keys[index], style: site.style, site }),
  );

  const edits: Array<Edit> = [];

  const registryOffset =
    registryOffsetFor(ast, discovered.sites[0].start) ??
    binding.firstStatementStart;
  if (registryOffset == null) {
    return {
      status: 'refused',
      reason: 'could not find a place to declare the style registry',
    };
  }

  if (!binding.alreadyImported) {
    if (binding.lastImportEnd != null) {
      edits.push({
        start: binding.lastImportEnd,
        end: binding.lastImportEnd,
        text: `\n${emitImport(binding.localName)}`,
      });
    } else {
      edits.push({
        start: registryOffset,
        end: registryOffset,
        text: `${emitImport(binding.localName)}\n\n`,
      });
    }
  }

  edits.push({
    start: registryOffset,
    end: registryOffset,
    text: `${emitCreateCall(binding.localName, registryName, entries)}\n\n`,
  });

  for (const entry of entries) {
    edits.push({
      start: entry.site.start,
      end: entry.site.end,
      text: emitPropsSpread(binding.localName, registryName, entry.key),
    });
  }

  return {
    status: 'converted',
    code: applyEdits(source, edits),
    entries,
    registryName,
    namespace: binding.localName,
    refusals: discovered.refusals,
  };
}
