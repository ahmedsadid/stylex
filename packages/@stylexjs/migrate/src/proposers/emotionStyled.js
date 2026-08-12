/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { emotionStyledTemplateBaseline } from '../adapters/emotion/baseline';
import { discoverStyledReadinessFacts } from '../adapters/emotion/styledReadiness';
import {
  discoverStyledTemplateFacts,
  readClosedStyledTemplate,
} from '../adapters/emotion/styledTemplate';
import { discoverStyledUsageFacts } from '../adapters/emotion/styledUsage';
import { compareDeclarations, describeDifferences } from '../compare/model';
import { compileStyleX } from '../evidence/compile';
import { evidence } from '../evidence/claims';
import { describeLintMessages, lintStyleX } from '../evidence/lint';
import { stylexCssForKey } from '../evidence/staticCss';
import { hashString } from '../kernel/hash';
import {
  collectUsedNames,
  freeName,
  resolveModuleBinding,
} from '../static/bindings';
import {
  emitCreateCall,
  emitImport,
  emitPropsSpread,
  sanitizeKey,
  STYLEX_MODULE,
} from '../static/emit';
import { parseSource } from '../static/parse';
import { applyEditsWithPlacements } from '../static/rewrite';
import { walk } from '../static/walk';
import type { Fact } from '../inventory/model';
import type { EvidenceResult } from '../kernel/evidence';
import type { Edit } from '../static/rewrite';
import type { StyleObject } from '../static/ir';

export const STYLED_COMPARISON_MODEL: string =
  'emotion-styled-flat-intrinsic-v1';

type ConvertedStyled = {
  +status: 'converted',
  +code: string,
  +namespace: string,
  +registryName: string,
  +styleKey: string,
  +componentName: string,
  +targetName: string,
  +css: string,
  +generatedNameStarts: $ReadOnlyArray<number>,
};

type ConversionResult =
  | ConvertedStyled
  | { +status: 'refused', +reason: string };

export type StyledProposal =
  | {
      +status: 'proposed',
      +code: string,
      +model: string,
      +sourceHash: string,
      +generatedHash: string,
      +evidence: $ReadOnlyArray<EvidenceResult>,
      +uncovered: $ReadOnlyArray<string>,
    }
  | {
      +status: 'refused',
      +reason: string,
      +evidence: $ReadOnlyArray<EvidenceResult>,
    };

function currentFacts({
  ast,
  file,
  readinessFact,
  usageFact,
  grammarFact,
}: {
  +ast: $FlowFixMe,
  +file: string,
  +readinessFact: Fact,
  +usageFact: Fact,
  +grammarFact: Fact,
}):
  | {
      +ok: true,
      +readiness: Fact,
      +usage: Fact,
      +grammar: Fact,
      +allReadiness: $ReadOnlyArray<Fact>,
    }
  | { +ok: false, +reason: string } {
  const readinessFacts = discoverStyledReadinessFacts({ ast, file });
  const usageFacts = discoverStyledUsageFacts({
    ast,
    file,
    readinessFacts,
  });
  const grammarFacts = discoverStyledTemplateFacts({
    ast,
    file,
    readinessFacts,
    usageFacts,
  });
  const readiness = readinessFacts.find((fact) => fact.id === readinessFact.id);
  const usage = usageFacts.find((fact) => fact.id === usageFact.id);
  const grammar = grammarFacts.find((fact) => fact.id === grammarFact.id);
  if (readiness == null || usage == null || grammar == null) {
    return {
      ok: false,
      reason: 'styled facts do not match the current source bytes',
    };
  }
  const usageValue: $FlowFixMe = usage.value;
  const grammarValue: $FlowFixMe = grammar.value;
  if (
    usageValue.definitionFactId !== readiness.id ||
    grammarValue.definitionFactId !== readiness.id ||
    grammarValue.usageFactId !== usage.id ||
    usageValue.firstSliceEligible !== true ||
    grammarValue.supported !== true
  ) {
    return {
      ok: false,
      reason: 'styled facts do not describe an eligible closed intrinsic',
    };
  }
  return { ok: true, readiness, usage, grammar, allReadiness: readinessFacts };
}

function componentStyleKey(name: string): string {
  return sanitizeKey(`${name.charAt(0).toLowerCase()}${name.slice(1)}`);
}

function removableStyledImport(
  ast: $FlowFixMe,
  readinessFacts: $ReadOnlyArray<Fact>,
): { +start: number, +end: number } | null {
  if (readinessFacts.length !== 1) return null;
  let declaration = null;
  let localName = null;
  for (const statement of ast.program?.body ?? []) {
    if (
      statement.type === 'ImportDeclaration' &&
      statement.source?.value === '@emotion/styled' &&
      (statement.specifiers ?? []).length === 1 &&
      typeof statement.specifiers[0].local?.name === 'string'
    ) {
      declaration = statement;
      localName = String(statement.specifiers[0].local.name);
    }
  }
  if (declaration == null || localName == null) return null;
  let uses = 0;
  walk(ast, (node) => {
    if (node.type === 'Identifier' && node.name === localName) uses++;
  });
  // One import binding and one tag/callee reference. Any additional use keeps
  // the import; unused-import cleanup must never erase an unmodeled styled API.
  if (uses !== 2) return null;
  return Object.freeze({ start: declaration.start, end: declaration.end });
}

export function convertClosedStyledDefinition({
  source,
  filename,
  readinessFact,
  usageFact,
  grammarFact,
}: {
  +source: string,
  +filename: string,
  +readinessFact: Fact,
  +usageFact: Fact,
  +grammarFact: Fact,
}): ConversionResult {
  const parsed = parseSource(source, filename);
  if (!parsed.ok) return { status: 'refused', reason: parsed.reason };
  const facts = currentFacts({
    ast: parsed.ast,
    file: filename,
    readinessFact,
    usageFact,
    grammarFact,
  });
  if (!facts.ok) return { status: 'refused', reason: facts.reason };
  const readiness: $FlowFixMe = facts.readiness.value;
  const usage: $FlowFixMe = facts.usage.value;
  const grammar: $FlowFixMe = facts.grammar.value;
  const declarationSpan = usage.declarationSpan;
  if (
    typeof declarationSpan?.start !== 'number' ||
    typeof declarationSpan?.end !== 'number' ||
    usage.standaloneDeclaration !== true ||
    usage.declarationKind !== 'const' ||
    typeof readiness.span?.start !== 'number' ||
    typeof usage.targetName !== 'string'
  ) {
    return {
      status: 'refused',
      reason: 'styled declaration boundary is incomplete',
    };
  }
  const css = readClosedStyledTemplate(parsed.ast, readiness.span.start);
  if (css == null) {
    return {
      status: 'refused',
      reason: 'closed styled template text is unavailable',
    };
  }
  const componentName = String(usage.name);
  const targetName = String(usage.targetName);
  const style: StyleObject = Object.freeze({
    declarations: Object.freeze(
      (grammar.declarations ?? []).map((declaration) =>
        Object.freeze({
          property: String(declaration.property),
          value: String(declaration.value),
        }),
      ),
    ),
  });
  const binding = resolveModuleBinding(parsed.ast, STYLEX_MODULE, 'stylex');
  const registryName = freeName('styles', collectUsedNames(parsed.ast));
  const styleKey = componentStyleKey(componentName);
  const createCall = emitCreateCall(binding.localName, registryName, [
    { key: styleKey, style },
  ]);
  const edits: Array<Edit> = [];
  const styledImport = removableStyledImport(parsed.ast, facts.allReadiness);
  if (!binding.alreadyImported) {
    if (styledImport != null && binding.lastImportEnd === styledImport.end) {
      edits.push({
        start: styledImport.start,
        end: styledImport.end,
        text: emitImport(binding.localName),
      });
    } else if (binding.lastImportEnd != null) {
      edits.push({
        start: binding.lastImportEnd,
        end: binding.lastImportEnd,
        text: `\n${emitImport(binding.localName)}`,
      });
    } else {
      edits.push({
        start: declarationSpan.start,
        end: declarationSpan.start,
        text: `${emitImport(binding.localName)}\n\n`,
      });
    }
  } else if (styledImport != null) {
    edits.push({ start: styledImport.start, end: styledImport.end, text: '' });
  }
  if (
    styledImport != null &&
    !binding.alreadyImported &&
    binding.lastImportEnd !== styledImport.end
  ) {
    edits.push({ start: styledImport.start, end: styledImport.end, text: '' });
  }
  edits.push({
    start: declarationSpan.start,
    end: declarationSpan.end,
    text: createCall,
  });
  const nameEditIndexes = [];
  for (const consumer of usage.consumers ?? []) {
    const opening = consumer.openingName;
    if (
      typeof opening?.start !== 'number' ||
      typeof opening?.end !== 'number' ||
      source.slice(opening.start, opening.end) !== componentName
    ) {
      return {
        status: 'refused',
        reason: 'styled JSX consumer boundary is stale',
      };
    }
    nameEditIndexes.push(edits.length);
    edits.push({ start: opening.start, end: opening.end, text: targetName });
    edits.push({
      start: opening.end,
      end: opening.end,
      text: ` ${emitPropsSpread(binding.localName, registryName, styleKey)}`,
    });
    const closing = consumer.closingName;
    if (closing != null) {
      if (
        typeof closing.start !== 'number' ||
        typeof closing.end !== 'number' ||
        source.slice(closing.start, closing.end) !== componentName
      ) {
        return {
          status: 'refused',
          reason: 'styled JSX closing boundary is stale',
        };
      }
      edits.push({ start: closing.start, end: closing.end, text: targetName });
    }
  }
  const rewritten = applyEditsWithPlacements(source, edits);
  return Object.freeze({
    status: 'converted',
    code: rewritten.code,
    namespace: binding.localName,
    registryName,
    styleKey,
    componentName,
    targetName,
    css,
    generatedNameStarts: Object.freeze(
      nameEditIndexes.map((index) => rewritten.placements[index]),
    ),
  });
}

type StyledStructure = {
  +importText: string,
  +createCallText: string,
};

function readStyledStructure(
  code: string,
  filename: string,
  converted: ConvertedStyled,
):
  | { +ok: true, +structure: StyledStructure }
  | { +ok: false, +reason: string } {
  const parsed = parseSource(code, filename);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  let importText = null;
  let createCallText = null;
  let matchedConsumers = 0;
  let oldBindingUses = 0;
  walk(parsed.ast, (node) => {
    if (
      node.type === 'ImportDeclaration' &&
      node.source?.value === STYLEX_MODULE &&
      (node.specifiers ?? []).some(
        (specifier) => specifier.local?.name === converted.namespace,
      )
    ) {
      importText = code.slice(node.start, node.end);
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.name === converted.registryName &&
      node.init?.type === 'CallExpression' &&
      node.init.callee?.type === 'MemberExpression' &&
      node.init.callee.object?.name === converted.namespace &&
      node.init.callee.property?.name === 'create'
    ) {
      createCallText = code.slice(node.init.start, node.init.end);
    }
    if (
      (node.type === 'Identifier' || node.type === 'JSXIdentifier') &&
      node.name === converted.componentName
    ) {
      oldBindingUses++;
    }
    if (
      node.type === 'JSXOpeningElement' &&
      converted.generatedNameStarts.includes(node.name?.start) &&
      node.name?.type === 'JSXIdentifier' &&
      node.name.name === converted.targetName
    ) {
      const wired = (node.attributes ?? []).some(
        (attribute) =>
          attribute.type === 'JSXSpreadAttribute' &&
          attribute.argument?.type === 'CallExpression' &&
          attribute.argument.callee?.type === 'MemberExpression' &&
          attribute.argument.callee.object?.name === converted.namespace &&
          attribute.argument.callee.property?.name === 'props' &&
          attribute.argument.arguments?.[0]?.type === 'MemberExpression' &&
          attribute.argument.arguments[0].object?.name ===
            converted.registryName &&
          attribute.argument.arguments[0].property?.name === converted.styleKey,
      );
      if (wired) matchedConsumers++;
    }
  });
  if (importText == null || createCallText == null) {
    return {
      ok: false,
      reason: 'generated styled conversion is missing its StyleX registry',
    };
  }
  if (oldBindingUses !== 0) {
    return {
      ok: false,
      reason: `generated code still uses ${converted.componentName}`,
    };
  }
  if (matchedConsumers !== converted.generatedNameStarts.length) {
    return {
      ok: false,
      reason:
        'generated styled conversion did not wire every exact JSX consumer',
    };
  }
  const resolvedImport: string = importText;
  const resolvedCreate: string = createCallText;
  return {
    ok: true,
    structure: { importText: resolvedImport, createCallText: resolvedCreate },
  };
}

export function verifyStyledConversion({
  source,
  filename,
  converted,
}: {
  +source: string,
  +filename: string,
  +converted: ConvertedStyled,
}): StyledProposal {
  const results: Array<EvidenceResult> = [];
  const sourceHash = hashString(source);
  const generatedHash = hashString(converted.code);
  const subject = {
    file: filename,
    sourceHash,
    targetHash: generatedHash,
    model: STYLED_COMPARISON_MODEL,
  };
  const scope = [filename];
  const compiled = compileStyleX(converted.code, filename);
  results.push(
    evidence({
      check: 'stylex-plugin-transform',
      provider: '@stylexjs/babel-plugin',
      subject,
      scope,
      result: compiled.ok ? 'pass' : 'fail',
      ...(compiled.ok ? {} : { detail: compiled.reason }),
      limitations: ['the repository compiler configuration was not run'],
    }),
  );
  if (!compiled.ok) {
    return { status: 'refused', reason: compiled.reason, evidence: results };
  }
  const linted = lintStyleX(converted.code, filename);
  results.push(
    evidence({
      check: 'stylex-lint',
      provider: '@stylexjs/eslint-plugin',
      subject,
      scope,
      result: linted.ok ? 'pass' : 'fail',
      ...(linted.ok ? {} : { detail: describeLintMessages(linted.messages) }),
      limitations: [
        'only @stylexjs rules were run; the repository lint setup was not',
      ],
    }),
  );
  if (!linted.ok) {
    return {
      status: 'refused',
      reason: `StyleX lint rejected the styled output: ${describeLintMessages(linted.messages)}`,
      evidence: results,
    };
  }
  const structure = readStyledStructure(converted.code, filename, converted);
  results.push(
    evidence({
      check: 'styled-binding-integrity',
      provider: 'stylex-migrate',
      subject,
      scope,
      result: structure.ok ? 'pass' : 'fail',
      ...(structure.ok ? {} : { detail: structure.reason }),
    }),
  );
  if (!structure.ok) {
    return { status: 'refused', reason: structure.reason, evidence: results };
  }
  const baseline = emotionStyledTemplateBaseline(converted.css);
  const target = stylexCssForKey({
    importText: structure.structure.importText,
    registryName: converted.registryName,
    createCallText: structure.structure.createCallText,
    namespace: converted.namespace,
    key: converted.styleKey,
  });
  if (!baseline.ok || !target.ok) {
    const reason = !baseline.ok
      ? baseline.reason
      : !target.ok
        ? target.reason
        : 'styled comparison unexpectedly unavailable';
    results.push(
      evidence({
        check: 'static-css-comparison',
        provider: !baseline.ok
          ? '@emotion/serialize'
          : '@stylexjs/babel-plugin',
        subject,
        scope,
        result: 'unavailable',
        detail: reason,
      }),
    );
    return { status: 'refused', reason, evidence: results };
  }
  const comparison = compareDeclarations(
    baseline.declarations,
    target.declarations,
  );
  results.push(
    evidence({
      check: 'static-css-comparison',
      provider: 'stylex-migrate',
      subject,
      scope,
      result: comparison.equal ? 'pass' : 'fail',
      ...(comparison.equal
        ? {}
        : { detail: describeDifferences(comparison.differences) }),
      limitations: [
        'This comparison covers flat declarations only; repository checks and runtime evidence are separate.',
      ],
    }),
  );
  if (!comparison.equal) {
    return {
      status: 'refused',
      reason: `Styled CSS differs: ${describeDifferences(comparison.differences)}`,
      evidence: results,
    };
  }
  return Object.freeze({
    status: 'proposed',
    code: converted.code,
    model: STYLED_COMPARISON_MODEL,
    sourceHash,
    generatedHash,
    evidence: Object.freeze(results),
    uncovered: Object.freeze([
      'repository build, typecheck, lint, and tests were not run',
      'no runtime evidence: component-tree identity, refs, hydration, and rendered behavior were not exercised',
      'the @emotion/styled import may remain for other definitions and repository cleanup was not checked',
    ]),
  });
}

export function proposeClosedStyledConversion({
  source,
  filename,
  readinessFact,
  usageFact,
  grammarFact,
}: {
  +source: string,
  +filename: string,
  +readinessFact: Fact,
  +usageFact: Fact,
  +grammarFact: Fact,
}): StyledProposal {
  const converted = convertClosedStyledDefinition({
    source,
    filename,
    readinessFact,
    usageFact,
    grammarFact,
  });
  if (converted.status === 'refused') {
    return { ...converted, evidence: Object.freeze([]) };
  }
  return verifyStyledConversion({ source, filename, converted });
}
