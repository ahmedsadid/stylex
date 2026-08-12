/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import postcss from 'postcss';
import { serializeStyles } from '@emotion/serialize';
import { canonicalProperty, canonicalValue } from '../compare/model';
import { compileStyleX } from '../evidence/compile';

export const KEYFRAMES_REFEREE_MODEL: string = 'keyframes-referee-v1';

export type KeyframesDeclaration = {
  +property: string,
  +value: string,
  +important: boolean,
};

export type KeyframesFrame = {
  +selector: 'from' | 'to',
  +declarations: $ReadOnlyArray<KeyframesDeclaration>,
};

export type KeyframesObservation = {
  +name: string,
  +animationName: string,
  +frames: $ReadOnlyArray<KeyframesFrame>,
  +rootDeclarations: $ReadOnlyArray<KeyframesDeclaration>,
};

export type KeyframesObservationResult =
  | { +ok: true, +observation: KeyframesObservation }
  | { +ok: false, +reason: string };

export type KeyframesRefereeResult =
  | {
      +status: 'equivalent',
      +model: string,
      +differences: $ReadOnlyArray<string>,
    }
  | {
      +status: 'mismatch',
      +model: string,
      +differences: $ReadOnlyArray<string>,
    }
  | {
      +status: 'unsupported',
      +model: string,
      +reasons: $ReadOnlyArray<string>,
    };

function declarations(
  nodes: $ReadOnlyArray<$FlowFixMe>,
): KeyframesDeclaration[] | null {
  const result: Array<KeyframesDeclaration> = [];
  for (const node of nodes) {
    if (node.type !== 'decl') return null;
    result.push({
      property: canonicalProperty(String(node.prop)),
      value: canonicalValue(String(node.value)),
      important: node.important === true,
    });
  }
  return result;
}

function readCss(css: string): KeyframesObservationResult {
  let root;
  try {
    root = postcss.parse(css);
  } catch (error) {
    return {
      ok: false,
      reason: `keyframes CSS could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const atRules = (root.nodes ?? []).filter(
    (node) => node.type === 'atrule' && String(node.name) === 'keyframes',
  );
  if (atRules.length !== 1 || String(atRules[0].params) === '') {
    return { ok: false, reason: 'expected exactly one named @keyframes rule' };
  }
  const frames = [];
  for (const node of atRules[0].nodes ?? []) {
    const selector = String(node.selector);
    if (
      node.type !== 'rule' ||
      (selector !== 'from' && selector !== 'to') ||
      frames.some((frame) => frame.selector === selector)
    ) {
      return {
        ok: false,
        reason: 'keyframes require unique from and to frames',
      };
    }
    const frameDeclarations = declarations(node.nodes ?? []);
    if (frameDeclarations == null) {
      return { ok: false, reason: `unsupported ${selector} frame contents` };
    }
    frames.push({ selector, declarations: frameDeclarations });
  }
  if (frames.length !== 2) {
    return { ok: false, reason: 'keyframes require both from and to frames' };
  }
  const rootNodes = (root.nodes ?? [])
    .filter((node) => node !== atRules[0])
    .flatMap((node) => (node.type === 'rule' ? (node.nodes ?? []) : [node]));
  const rootDeclarations = declarations(rootNodes);
  if (rootDeclarations == null) {
    return { ok: false, reason: 'unsupported CSS beside the keyframes rule' };
  }
  const animationNames = rootDeclarations.filter(
    (item) => item.property === 'animation-name',
  );
  if (animationNames.length !== 1) {
    return {
      ok: false,
      reason: 'expected exactly one animation-name reference',
    };
  }
  return {
    ok: true,
    observation: {
      name: String(atRules[0].params),
      animationName: animationNames[0].value,
      frames: Object.freeze(frames),
      rootDeclarations: Object.freeze(rootDeclarations),
    },
  };
}

export function observeEmotionKeyframes(
  style: mixed,
): KeyframesObservationResult {
  try {
    return readCss(String(serializeStyles([style]).styles));
  } catch (error) {
    return {
      ok: false,
      reason: `Emotion keyframes serialization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function observeStyleXKeyframes(
  source: string,
  filename: string,
): KeyframesObservationResult {
  const compiled = compileStyleX(source, filename);
  if (!compiled.ok) return compiled;
  return readCss(compiled.ruleMetadata.map((rule) => rule.ltr).join(''));
}

function identity(item: KeyframesDeclaration): string {
  return `${item.property}\0${item.value}\0${item.important ? 'important' : ''}`;
}

function normalizedRoot(
  observation: KeyframesObservation,
): $ReadOnlyArray<string> {
  return observation.rootDeclarations
    .map((item) =>
      item.property === 'animation-name'
        ? { ...item, value: '$KEYFRAME' }
        : item,
    )
    .map(identity)
    .sort();
}

function normalizedFrames(
  observation: KeyframesObservation,
): $ReadOnlyArray<string> {
  return observation.frames
    .flatMap((frame) =>
      frame.declarations.map((item) => `${frame.selector}\0${identity(item)}`),
    )
    .sort();
}

export function refereeKeyframes(
  source: KeyframesObservation,
  target: KeyframesObservation,
): KeyframesRefereeResult {
  const reasons = [];
  if (source.animationName !== source.name) {
    reasons.push('source animation-name does not reference its keyframes rule');
  }
  if (target.animationName !== target.name) {
    reasons.push('target animation-name does not reference its keyframes rule');
  }
  if (
    [...source.frames, ...target.frames].some((frame) =>
      frame.declarations.some((item) => item.important),
    )
  ) {
    reasons.push('!important is outside the first keyframes grammar');
  }
  if (reasons.length > 0) {
    return {
      status: 'unsupported',
      model: KEYFRAMES_REFEREE_MODEL,
      reasons: Object.freeze(reasons.sort()),
    };
  }
  const differences = [];
  if (
    JSON.stringify(normalizedFrames(source)) !==
    JSON.stringify(normalizedFrames(target))
  ) {
    differences.push('keyframe declarations differ');
  }
  if (
    JSON.stringify(normalizedRoot(source)) !==
    JSON.stringify(normalizedRoot(target))
  ) {
    differences.push('animation declarations differ after alpha-renaming');
  }
  if (differences.length === 0) {
    return {
      status: 'equivalent',
      model: KEYFRAMES_REFEREE_MODEL,
      differences: Object.freeze([]),
    };
  }
  return {
    status: 'mismatch',
    model: KEYFRAMES_REFEREE_MODEL,
    differences: Object.freeze(differences),
  };
}
