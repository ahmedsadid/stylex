/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export { VERSION } from './version';

export {
  hashFields,
  hashString,
  shortHash,
  HASH_ALGORITHM,
} from './kernel/hash';

export {
  canonicalRoot,
  createSnapshot,
  detectMovedHead,
  detectStaleFiles,
  extendSnapshot,
  gitCommitOf,
  isWorktreeClean,
  snapshotHash,
} from './kernel/snapshot';
export type { WorkspaceSnapshot } from './kernel/snapshot';

export {
  allowedTransitions,
  canTransition,
  isTerminal,
  transition,
} from './kernel/state';
export type { Actor, MigrationState } from './kernel/state';

export {
  assertCleanWorktree,
  createCandidateWorkspace,
  removeCandidateWorkspace,
} from './candidate/workspace';
export type { CandidateWorkspace } from './candidate/workspace';

export { changedPaths, createCandidatePatch, isEmpty } from './candidate/patch';
export type {
  CandidatePatch,
  CandidateResult,
  FileChange,
  Proposer,
  ProposerKind,
} from './candidate/patch';

export {
  DEFAULT_FORBIDDEN_PATHS,
  LEDGER_DIRECTORY,
  globToRegExp,
  matchesGlob,
  validateScope,
} from './candidate/scope';
export type {
  ChangedPath,
  FileChangeStatus,
  ScopeResult,
  ScopeRules,
  ScopeViolation,
  ScopeViolationReason,
} from './candidate/scope';

/**
 * The writer itself is not exported. Reaching the user's files goes through a
 * apply plan, which requires an immutable candidate, evidence bound to that
 * candidate's hash, and an approval naming it. Exposing the low-level writer
 * would make all of that optional.
 */
export type { WriteIO, WriteResult } from './candidate/write';

export {
  approve,
  bundleEvidence,
  applyPlan,
  MECHANICAL_COMPARISON_MODEL,
  MECHANICAL_POLICY_ID,
} from './kernel/applyPlan';
export type {
  Approval,
  ApplyPlan,
  ApplyPlanEntry,
  ApplyPlanResult,
  EvidenceBundle,
} from './kernel/applyPlan';

export { parseSource, pluginsForFilename } from './static/parse';
export type { ParseResult } from './static/parse';

export { isEmptyStyle, styleObject } from './static/ir';
export type { Declaration, StaticValue, StyleObject } from './static/ir';

export { walk } from './static/walk';

export {
  STYLEX_MODULE,
  allocateKeys,
  emitCreateCall,
  emitImport,
  emitPropsSpread,
  emitStyleObject,
  sanitizeKey,
  serializeValue,
} from './static/emit';
export type { StyleEntry } from './static/emit';

export { applyEdits } from './static/rewrite';
export type { Edit } from './static/rewrite';

export {
  collectUsedNames,
  freeName,
  resolveModuleBinding,
} from './static/bindings';
export type { ModuleBinding } from './static/bindings';

export {
  COMPARISON_MODEL,
  canonicalValue,
  compareDeclarations,
  describeDifferences,
  parseDeclarations,
  parseRule,
} from './compare/model';
export type {
  ComparisonResult,
  CssDeclaration,
  Difference,
} from './compare/model';

export { allPassed, makeEvidence } from './kernel/evidence';
export type {
  Claim,
  CheckOutcome,
  EvidenceResult,
  EvidenceSubject,
} from './kernel/evidence';

export { evidence, packageVersion } from './evidence/claims';

export { compileStyleX } from './evidence/compile';
export { describeLintMessages, lintStyleX } from './evidence/lint';
export type { LintMessage, LintResult } from './evidence/lint';
export { stylexCssForKey } from './evidence/staticCss';

export { emotionBaseline } from './adapters/emotion/baseline';

/**
 * The supported way to convert an Emotion file. It runs the checks itself and
 * cannot return code that failed them.
 */
export {
  proposeStaticConversion,
  verifyConversion,
} from './proposers/emotionStatic';
export type { Proposal, ProposedEntry } from './proposers/emotionStatic';

export {
  discover,
  isShorthandProperty,
  usesEmotion,
} from './adapters/emotion/discover';
export type {
  DiscoveryResult,
  EmotionRefusal,
  EmotionSite,
  RefusalReason,
} from './adapters/emotion/discover';
