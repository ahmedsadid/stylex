/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import { discoverStyledReadinessFacts } from '../adapters/emotion/styledReadiness';
import { discoverStyledThemeTemplateFacts } from '../adapters/emotion/styledTemplate';
import { discoverStyledUsageFacts } from '../adapters/emotion/styledUsage';
import {
  collectUsedNames,
  freeName,
  resolveModuleBinding,
} from '../static/bindings';
import {
  STYLEX_MODULE,
  allocateKeys,
  sanitizeKey,
  serializeValue,
} from '../static/emit';
import { isShorthandProperty } from '../adapters/emotion/discover';
import { applyEditsWithPlacements } from '../static/rewrite';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import { discoverThemeFacts } from './discover';
import { emitThemeModule } from './emit';
import {
  relativeThemeModuleSpecifier,
  validateThemeDecisionApproval,
  validateThemeDecisionDraft,
} from './model';
import type { Edit } from '../static/rewrite';
import type { Fact } from '../inventory/model';
import type {
  ThemeDecisionApproval,
  ThemeDecisionDraft,
  ThemeValue,
} from './model';

export type ThemeProposal = {
  +status: 'proposed',
  +files: { +[file: string]: string },
  +changedFiles: $ReadOnlyArray<string>,
  +siteSpansByFile: {
    +[file: string]: $ReadOnlyArray<ThemeProposalSiteSpan>,
  },
  +decisionArtifactHash: string,
};

export type ThemeProposalSiteSpan = {
  +kind: 'theme-css' | 'theme-provider' | 'theme-styled',
  +start: number,
  +end: number,
};

export type ThemeProposalOutcome =
  | ThemeProposal
  | { +status: 'refused', +reason: string, +file: string | null };

type StyleProperty = {
  +name: string,
  +value: string,
};

type StyleSite = {
  +attributeStart: number,
  +attributeEnd: number,
  +statementStart: number,
  +elementName: string,
  +properties: $ReadOnlyArray<StyleProperty>,
};

type StyledThemeSite = {
  +definitionStart: number,
  +definitionEnd: number,
  +declarationStart: number,
  +declarationEnd: number,
  +componentName: string,
  +targetName: string,
  +properties: $ReadOnlyArray<StyleProperty>,
  +consumers: $ReadOnlyArray<$FlowFixMe>,
};

type ProviderEdit = {
  +openingStart: number,
  +openingEnd: number,
  +closingStart: number,
  +closingEnd: number,
  +childNameEnd: number,
  +variantExport: string,
  +emotionImport: $FlowFixMe,
  +emotionSpecifier: $FlowFixMe,
  +sourceImport: $FlowFixMe | null,
  +sourceSpecifier: $FlowFixMe | null,
  +sourceLocal: string | null,
};

const PROPERTY = /^[A-Za-z][A-Za-z0-9]*$/;

function componentStyleKey(name: string): string {
  return sanitizeKey(`${name.charAt(0).toLowerCase()}${name.slice(1)}`);
}

function elementName(opening: $FlowFixMe): string | null {
  return opening?.name?.type === 'JSXIdentifier'
    ? String(opening.name.name)
    : null;
}

function host(name: string | null): boolean {
  return name != null && name[0] === name[0].toLowerCase();
}

function literalPropertyName(property: $FlowFixMe): string | null {
  if (property?.type !== 'ObjectProperty' || property.computed === true) {
    return null;
  }
  if (property.key?.type === 'Identifier') return String(property.key.name);
  if (property.key?.type === 'StringLiteral') return String(property.key.value);
  return null;
}

function runtimeValue(value: $FlowFixMe): ThemeValue | null {
  if (value?.type === 'StringLiteral') return String(value.value);
  if (value?.type === 'NumericLiteral' && Number.isFinite(value.value)) {
    return Number(value.value);
  }
  return null;
}

function factValue(fact: Fact): $FlowFixMe {
  return fact.value as any;
}

function styleObject(
  object: $FlowFixMe,
  reads: Map<string, Fact>,
  draft: ThemeDecisionDraft,
  usedReads: Set<string>,
): $ReadOnlyArray<StyleProperty> | null {
  if (object?.type !== 'ObjectExpression') return null;
  const tokens = new Map(
    draft.tokens.map((token) => [token.sourcePath, token.targetName]),
  );
  const properties = [];
  for (const property of object.properties ?? []) {
    const name = literalPropertyName(property);
    if (
      name == null ||
      !PROPERTY.test(name) ||
      isShorthandProperty(name) ||
      property.value == null
    ) {
      return null;
    }
    const literal = runtimeValue(property.value);
    if (literal != null) {
      properties.push(Object.freeze({ name, value: serializeValue(literal) }));
      continue;
    }
    const key = `${String(property.value.start)}:${String(property.value.end)}`;
    const read = reads.get(key);
    const sourcePath = read == null ? null : factValue(read).sourcePath;
    const targetName =
      typeof sourcePath === 'string' ? tokens.get(sourcePath) : null;
    if (targetName == null) return null;
    usedReads.add(key);
    properties.push(
      Object.freeze({
        name,
        value: `${draft.varsExport}.${targetName}`,
      }),
    );
  }
  return properties.length === 0 ? null : Object.freeze(properties);
}

function styleSites(
  ast: $FlowFixMe,
  draft: ThemeDecisionDraft,
  reads: Map<string, Fact>,
  usedReads: Set<string>,
): { +sites: $ReadOnlyArray<StyleSite>, +problem: string | null } {
  const sites = [];
  let problem = null;
  walk(ast, (node) => {
    if (problem != null || node.type !== 'JSXOpeningElement') return;
    const name = elementName(node);
    if (!host(name)) return;
    const attributes = node.attributes ?? [];
    const cssAttributes = attributes.filter(
      (attribute) =>
        attribute.type === 'JSXAttribute' && attribute.name?.name === 'css',
    );
    if (cssAttributes.length === 0) return;
    if (
      cssAttributes.length !== 1 ||
      attributes.some(
        (attribute) =>
          attribute.type === 'JSXSpreadAttribute' ||
          (attribute.type === 'JSXAttribute' &&
            (attribute.name?.name === 'className' ||
              attribute.name?.name === 'style')),
      )
    ) {
      problem =
        'theme css site has a spread, className, style, or duplicate css prop';
      return;
    }
    const attribute = cssAttributes[0];
    let expression = attribute.value?.expression;
    if (expression?.type === 'ArrowFunctionExpression') {
      if (
        expression.async === true ||
        expression.params?.length !== 1 ||
        expression.params[0]?.type !== 'Identifier'
      ) {
        problem =
          'theme css callback is not a synchronous one-parameter function';
        return;
      }
      expression = expression.body;
    }
    const properties = styleObject(expression, reads, draft, usedReads);
    if (
      properties == null ||
      typeof attribute.start !== 'number' ||
      typeof attribute.end !== 'number' ||
      typeof node.start !== 'number' ||
      name == null
    ) {
      problem = 'theme css site is outside the approved flat object boundary';
      return;
    }
    sites.push(
      Object.freeze({
        attributeStart: attribute.start,
        attributeEnd: attribute.end,
        statementStart:
          (ast.program?.body ?? []).find(
            (statement) =>
              statement.start <= attribute.start &&
              attribute.end <= statement.end,
          )?.start ?? node.start,
        elementName: name,
        properties,
      }),
    );
  });
  return Object.freeze({ sites: Object.freeze(sites), problem });
}

function styledThemeSites(
  ast: $FlowFixMe,
  file: string,
  draft: ThemeDecisionDraft,
  themeFacts: $ReadOnlyArray<Fact>,
  usedReads: Set<string>,
): {
  +sites: $ReadOnlyArray<StyledThemeSite>,
  +readinessFacts: $ReadOnlyArray<Fact>,
  +problem: string | null,
} {
  const readinessFacts = discoverStyledReadinessFacts({ ast, file });
  const usageFacts = discoverStyledUsageFacts({ ast, file, readinessFacts });
  const grammarFacts = discoverStyledThemeTemplateFacts({
    ast,
    file,
    readinessFacts,
    usageFacts,
    themeFacts,
  }).filter((fact) => factValue(fact).supported === true);
  if (grammarFacts.length === 0) {
    return Object.freeze({
      sites: Object.freeze([]),
      readinessFacts,
      problem: null,
    });
  }
  if (grammarFacts.length !== 1) {
    return Object.freeze({
      sites: Object.freeze([]),
      readinessFacts,
      problem: 'theme consumer has more than one eligible styled definition',
    });
  }
  const grammarFact = grammarFacts[0];
  const grammar = factValue(grammarFact);
  const usageFact = usageFacts.find((fact) => fact.id === grammar.usageFactId);
  const readinessFact = readinessFacts.find(
    (fact) => fact.id === grammar.definitionFactId,
  );
  const usage = usageFact == null ? null : factValue(usageFact);
  const readiness = readinessFact == null ? null : factValue(readinessFact);
  const declaration = usage?.declarationSpan;
  if (
    usageFact == null ||
    readinessFact == null ||
    usage?.themeSliceEligible !== true ||
    typeof declaration?.start !== 'number' ||
    typeof declaration?.end !== 'number' ||
    typeof readiness?.span?.start !== 'number' ||
    typeof readiness?.span?.end !== 'number' ||
    typeof usage?.targetName !== 'string'
  ) {
    return Object.freeze({
      sites: Object.freeze([]),
      readinessFacts,
      problem: 'styled theme graph is incomplete or stale',
    });
  }
  const tokens = new Map(
    draft.tokens.map((token) => [token.sourcePath, token.targetName]),
  );
  const properties = [];
  for (const item of grammar.declarations ?? []) {
    if (typeof item.property !== 'string') {
      return Object.freeze({
        sites: Object.freeze([]),
        readinessFacts,
        problem: 'styled theme declaration property is unavailable',
      });
    }
    if (typeof item.value === 'string') {
      properties.push(
        Object.freeze({
          name: item.property,
          value: serializeValue(item.value),
        }),
      );
      continue;
    }
    const targetName = tokens.get(String(item.sourcePath));
    const readKey = `${String(item.readSpan?.start)}:${String(item.readSpan?.end)}`;
    if (
      targetName == null ||
      !themeFacts.some((fact) => {
        const value = factValue(fact);
        return (
          fact.kind === 'theme-read' &&
          `${String(value.span?.start)}:${String(value.span?.end)}` ===
            readKey &&
          value.sourcePath === item.sourcePath
        );
      })
    ) {
      return Object.freeze({
        sites: Object.freeze([]),
        readinessFacts,
        problem: 'styled theme callback uses an unmapped or stale token read',
      });
    }
    usedReads.add(readKey);
    properties.push(
      Object.freeze({
        name: item.property,
        value: `${draft.varsExport}.${targetName}`,
      }),
    );
  }
  return Object.freeze({
    sites: Object.freeze([
      Object.freeze({
        definitionStart: readiness.span.start,
        definitionEnd: readiness.span.end,
        declarationStart: declaration.start,
        declarationEnd: declaration.end,
        componentName: String(usage.name),
        targetName: String(usage.targetName),
        properties: Object.freeze(properties),
        consumers: Object.freeze(usage.consumers ?? []),
      }),
    ]),
    readinessFacts,
    problem: null,
  });
}

function emotionProviderImports(ast: $FlowFixMe): Map<string, $FlowFixMe> {
  const bindings = new Map<string, $FlowFixMe>();
  for (const statement of ast.program?.body ?? []) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.source?.value !== '@emotion/react'
    ) {
      continue;
    }
    for (const specifier of statement.specifiers ?? []) {
      if (
        specifier.type === 'ImportSpecifier' &&
        (specifier.imported?.name === 'ThemeProvider' ||
          specifier.imported?.value === 'ThemeProvider')
      ) {
        bindings.set(String(specifier.local.name), { statement, specifier });
      }
    }
  }
  return bindings;
}

function importedLocals(ast: $FlowFixMe): Map<string, $FlowFixMe> {
  const bindings = new Map<string, $FlowFixMe>();
  for (const statement of ast.program?.body ?? []) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.type === 'Identifier') {
        bindings.set(String(specifier.local.name), { statement, specifier });
      }
    }
  }
  return bindings;
}

function identifierSpanCount(ast: $FlowFixMe, name: string): number {
  const spans = new Set<string>();
  walk(ast, (node) => {
    if (
      node.type === 'Identifier' &&
      node.name === name &&
      typeof node.start === 'number' &&
      typeof node.end === 'number'
    ) {
      spans.add(`${node.start}:${node.end}`);
    }
  });
  return spans.size;
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
  return uses === 2
    ? Object.freeze({ start: declaration.start, end: declaration.end })
    : null;
}

function extensionless(file: string): string {
  return file.replace(/\.(?:js|jsx|ts|tsx)$/, '');
}

function declaredVariantBinding(
  file: string,
  binding: $FlowFixMe | null,
  draft: ThemeDecisionDraft,
): boolean {
  if (binding == null) return draft.sourceFiles.includes(file);
  const source = binding.statement?.source?.value;
  if (typeof source !== 'string' || !source.startsWith('.')) return false;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), source),
  );
  return draft.sourceFiles.some(
    (declared) => extensionless(declared) === extensionless(resolved),
  );
}

function staticHostSubtree(node: $FlowFixMe): boolean {
  if (node?.type !== 'JSXElement' || !host(elementName(node.openingElement))) {
    return false;
  }
  return (node.children ?? []).every((child) => {
    if (child.type === 'JSXText') return true;
    if (
      child.type === 'JSXExpressionContainer' &&
      child.expression?.type === 'JSXEmptyExpression'
    ) {
      return true;
    }
    return child.type === 'JSXElement' && staticHostSubtree(child);
  });
}

function providerEdits(
  ast: $FlowFixMe,
  file: string,
  draft: ThemeDecisionDraft,
): { +edits: $ReadOnlyArray<ProviderEdit>, +problem: string | null } {
  const imports = emotionProviderImports(ast);
  const localImports = importedLocals(ast);
  const variants = new Map(
    draft.variants.flatMap((variant) => [
      [variant.name, variant.exportName],
      [variant.exportName, variant.exportName],
    ]),
  );
  const edits = [];
  let problem = null;
  walk(ast, (node) => {
    if (problem != null || node.type !== 'JSXElement') return;
    const opening = node.openingElement;
    const name = elementName(opening);
    const imported = name == null ? null : imports.get(name);
    if (imported == null) return;
    const theme = (opening.attributes ?? []).find(
      (attribute) =>
        attribute.type === 'JSXAttribute' && attribute.name?.name === 'theme',
    );
    const selected = theme?.value?.expression;
    const selectedName =
      selected?.type === 'Identifier' ? String(selected.name) : null;
    const variantExport =
      selectedName == null ? null : variants.get(selectedName);
    const selectedBinding =
      selectedName == null ? null : (localImports.get(selectedName) ?? null);
    const selectedImport =
      selectedName != null && identifierSpanCount(ast, selectedName) === 2
        ? selectedBinding
        : null;
    const children = (node.children ?? []).filter(
      (child) => child.type !== 'JSXText' || String(child.value).trim() !== '',
    );
    const child = children.length === 1 ? children[0] : null;
    const childName =
      child?.type === 'JSXElement' ? elementName(child.openingElement) : null;
    if (
      variantExport == null ||
      child?.type !== 'JSXElement' ||
      !host(childName) ||
      !staticHostSubtree(child) ||
      !declaredVariantBinding(file, selectedBinding, draft) ||
      child.openingElement.attributes?.some(
        (attribute) =>
          attribute.type === 'JSXSpreadAttribute' ||
          (attribute.type === 'JSXAttribute' &&
            (attribute.name?.name === 'css' ||
              attribute.name?.name === 'className' ||
              attribute.name?.name === 'style')),
      ) ||
      typeof opening.start !== 'number' ||
      typeof opening.end !== 'number' ||
      typeof node.closingElement?.start !== 'number' ||
      typeof node.closingElement?.end !== 'number' ||
      typeof child.openingElement.name?.end !== 'number'
    ) {
      problem =
        'ThemeProvider is outside the approved declared-variant static-host-subtree boundary';
      return;
    }
    edits.push(
      Object.freeze({
        openingStart: opening.start,
        openingEnd: opening.end,
        closingStart: node.closingElement.start,
        closingEnd: node.closingElement.end,
        childNameEnd: child.openingElement.name.end,
        variantExport,
        emotionImport: imported.statement,
        emotionSpecifier: imported.specifier,
        sourceImport: selectedImport?.statement ?? null,
        sourceSpecifier: selectedImport?.specifier ?? null,
        sourceLocal: selectedImport == null ? null : selectedName,
      }),
    );
  });
  return Object.freeze({ edits: Object.freeze(edits), problem });
}

function registryText(
  stylexName: string,
  registryName: string,
  sites: $ReadOnlyArray<{
    +elementName: string,
    +properties: $ReadOnlyArray<StyleProperty>,
  }>,
): string {
  const keys = allocateKeys(sites.map((site) => site.elementName));
  const body = sites
    .map((site, index) => {
      const values = site.properties
        .map((property) => `    ${property.name}: ${property.value},`)
        .join('\n');
      return `  ${keys[index]}: {\n${values}\n  },`;
    })
    .join('\n');
  return `const ${registryName} = ${stylexName}.create({\n${body}\n});`;
}

function removeImportSpecifier(
  statement: $FlowFixMe,
  specifier: $FlowFixMe,
): Edit {
  const specifiers = statement.specifiers ?? [];
  if (specifiers.length === 1) {
    return { start: statement.start, end: statement.end, text: '' };
  }
  const index = specifiers.indexOf(specifier);
  if (index < specifiers.length - 1) {
    return {
      start: specifier.start,
      end: specifiers[index + 1].start,
      text: '',
    };
  }
  return { start: specifiers[index - 1].end, end: specifier.end, text: '' };
}

function rewriteConsumer(
  source: string,
  file: string,
  draft: ThemeDecisionDraft,
):
  | {
      +ok: true,
      +code: string,
      +siteSpans: $ReadOnlyArray<ThemeProposalSiteSpan>,
    }
  | { +ok: false, +reason: string } {
  const parsed = parseSource(source, file);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const ast = parsed.ast;
  const themeFacts = discoverThemeFacts({ ast, file });
  const reads = new Map(
    themeFacts
      .filter((fact) => fact.kind === 'theme-read')
      .map((fact) => {
        const value = factValue(fact);
        return [
          `${String(value.span?.start)}:${String(value.span?.end)}`,
          fact,
        ];
      }),
  );
  const usedReads = new Set<string>();
  const style = styleSites(ast, draft, reads, usedReads);
  const styled = styledThemeSites(ast, file, draft, themeFacts, usedReads);
  const providers = providerEdits(ast, file, draft);
  if (style.problem != null) return { ok: false, reason: style.problem };
  if (styled.problem != null) return { ok: false, reason: styled.problem };
  if (providers.problem != null)
    return { ok: false, reason: providers.problem };
  const unhandled = [...reads.keys()].filter((key) => !usedReads.has(key));
  if (unhandled.length > 0) {
    return {
      ok: false,
      reason: 'consumer contains theme reads outside converted style values',
    };
  }
  if (
    style.sites.length === 0 &&
    styled.sites.length === 0 &&
    providers.edits.length === 0
  ) {
    return { ok: false, reason: 'consumer contains no approved theme rewrite' };
  }

  const usedNames = new Set<string>(collectUsedNames(ast));
  providers.edits.forEach((edit) => {
    if (edit.sourceLocal != null) usedNames.delete(edit.sourceLocal);
  });
  const stylex = resolveModuleBinding(ast, STYLEX_MODULE, 'stylex');
  const registryName = freeName('styles', usedNames);
  usedNames.add(registryName);
  const requiredExports = new Set<string>();
  if (style.sites.length > 0 || styled.sites.length > 0) {
    requiredExports.add(draft.varsExport);
  }
  providers.edits.forEach((edit) => requiredExports.add(edit.variantExport));
  const locals = new Map<string, string>();
  for (const exported of [...requiredExports].sort()) {
    const local = freeName(exported, usedNames);
    usedNames.add(local);
    locals.set(exported, local);
  }
  const specifier = relativeThemeModuleSpecifier(file, draft.targetModule);
  const named = [...requiredExports]
    .sort()
    .map((exported) => {
      const local = locals.get(exported);
      return local === exported ? exported : `${exported} as ${String(local)}`;
    })
    .join(', ');
  const importLines = [];
  if (!stylex.alreadyImported) {
    importLines.push(
      `import * as ${stylex.localName} from '${STYLEX_MODULE}';`,
    );
  }
  importLines.push(`import { ${named} } from '${specifier}';`);
  const edits: Array<Edit> = [];
  const lastImportEnd = stylex.lastImportEnd;
  const firstStatement = ast.program?.body?.[0]?.start ?? 0;
  const importOffset = lastImportEnd ?? firstStatement;
  edits.push({
    start: importOffset,
    end: importOffset,
    text:
      lastImportEnd == null
        ? `${importLines.join('\n')}\n\n`
        : `\n${importLines.join('\n')}`,
  });

  if (style.sites.length > 0 || styled.sites.length > 0) {
    const registryOffset = Math.min(
      ...style.sites.map((site) => site.statementStart),
      ...styled.sites.map((site) => site.declarationStart),
    );
    const varsName = String(locals.get(draft.varsExport));
    const registrySites = [
      ...style.sites.map((site) => ({
        elementName: site.elementName,
        properties: site.properties,
      })),
      ...styled.sites.map((site) => ({
        elementName: componentStyleKey(site.componentName),
        properties: site.properties,
      })),
    ];
    const registry = registryText(
      stylex.localName,
      registryName,
      registrySites.map((site) => ({
        ...site,
        properties: site.properties.map((property) => ({
          ...property,
          value: property.value.replace(`${draft.varsExport}.`, `${varsName}.`),
        })),
      })),
    );
    const replacedStyled = styled.sites.find(
      (site) => site.declarationStart === registryOffset,
    );
    edits.push(
      replacedStyled == null
        ? {
            start: registryOffset,
            end: registryOffset,
            text: `${registry}\n\n`,
          }
        : {
            start: replacedStyled.declarationStart,
            end: replacedStyled.declarationEnd,
            text: registry,
          },
    );
    const keys = allocateKeys(registrySites.map((site) => site.elementName));
    style.sites.forEach((site, index) => {
      edits.push({
        start: site.attributeStart,
        end: site.attributeEnd,
        text: `{...${stylex.localName}.props(${registryName}.${keys[index]})}`,
      });
    });
    styled.sites.forEach((site, styledIndex) => {
      if (site !== replacedStyled) {
        edits.push({
          start: site.declarationStart,
          end: site.declarationEnd,
          text: '',
        });
      }
      const key = keys[style.sites.length + styledIndex];
      for (const consumer of site.consumers) {
        const opening = consumer.openingName;
        if (
          typeof opening?.start !== 'number' ||
          typeof opening?.end !== 'number' ||
          source.slice(opening.start, opening.end) !== site.componentName
        ) {
          throw new Error('styled theme JSX consumer boundary is stale');
        }
        edits.push(
          { start: opening.start, end: opening.end, text: site.targetName },
          {
            start: opening.end,
            end: opening.end,
            text: ` {...${stylex.localName}.props(${registryName}.${key})}`,
          },
        );
        const closing = consumer.closingName;
        if (closing != null) {
          if (
            typeof closing.start !== 'number' ||
            typeof closing.end !== 'number' ||
            source.slice(closing.start, closing.end) !== site.componentName
          ) {
            throw new Error('styled theme JSX closing boundary is stale');
          }
          edits.push({
            start: closing.start,
            end: closing.end,
            text: site.targetName,
          });
        }
      }
    });
  }
  const styledImport =
    styled.sites.length > 0
      ? removableStyledImport(ast, styled.readinessFacts)
      : null;
  if (styledImport != null) {
    edits.push({ start: styledImport.start, end: styledImport.end, text: '' });
  }
  const removedImports = new Set<string>();
  for (const provider of providers.edits) {
    edits.push(
      { start: provider.openingStart, end: provider.openingEnd, text: '' },
      { start: provider.closingStart, end: provider.closingEnd, text: '' },
      {
        start: provider.childNameEnd,
        end: provider.childNameEnd,
        text: ` {...${stylex.localName}.props(${String(locals.get(provider.variantExport))})}`,
      },
    );
    const importKey = `${String(provider.emotionSpecifier.start)}:${String(provider.emotionSpecifier.end)}`;
    if (!removedImports.has(importKey)) {
      edits.push(
        removeImportSpecifier(
          provider.emotionImport,
          provider.emotionSpecifier,
        ),
      );
      removedImports.add(importKey);
    }
    const sourceImport = provider.sourceImport;
    const sourceSpecifier = provider.sourceSpecifier;
    if (sourceImport != null && sourceSpecifier != null) {
      const sourceImportKey = `${String(sourceSpecifier.start)}:${String(sourceSpecifier.end)}`;
      if (!removedImports.has(sourceImportKey)) {
        edits.push(removeImportSpecifier(sourceImport, sourceSpecifier));
        removedImports.add(sourceImportKey);
      }
    }
  }
  try {
    const siteSpans: Array<ThemeProposalSiteSpan> = [
      ...style.sites.map((site) => ({
        kind: 'theme-css' as 'theme-css',
        start: site.attributeStart,
        end: site.attributeEnd,
      })),
      ...providers.edits.map((provider) => ({
        kind: 'theme-provider' as 'theme-provider',
        start: provider.openingStart,
        end: provider.openingEnd,
      })),
      ...styled.sites.map((site) => ({
        kind: 'theme-styled' as 'theme-styled',
        start: site.definitionStart,
        end: site.definitionEnd,
      })),
    ];
    return {
      ok: true,
      code: applyEditsWithPlacements(source, edits).code,
      siteSpans: Object.freeze(siteSpans.map((span) => Object.freeze(span))),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function proposeApprovedThemeFiles({
  files,
  draft: inputDraft,
  approval: inputApproval,
}: {
  +files: { +[file: string]: string | null },
  +draft: ThemeDecisionDraft,
  +approval: ThemeDecisionApproval,
}): ThemeProposalOutcome {
  const draft = validateThemeDecisionDraft(inputDraft);
  const approval = validateThemeDecisionApproval({
    draft,
    approval: inputApproval,
  });
  const proposed: { [file: string]: string } = {};
  const siteSpansByFile: {
    [file: string]: $ReadOnlyArray<ThemeProposalSiteSpan>,
  } = {};
  for (const consumer of draft.consumerFiles) {
    const source = files[consumer];
    if (typeof source !== 'string') {
      return {
        status: 'refused',
        reason: 'declared theme consumer is missing',
        file: consumer,
      };
    }
    const rewritten = rewriteConsumer(source, consumer, draft);
    if (!rewritten.ok) {
      return { status: 'refused', reason: rewritten.reason, file: consumer };
    }
    proposed[consumer] = rewritten.code;
    siteSpansByFile[consumer] = rewritten.siteSpans;
  }
  const moduleSource = emitThemeModule(draft);
  const existingModule = files[draft.targetModule];
  if (existingModule != null && existingModule !== moduleSource) {
    return {
      status: 'refused',
      reason: 'theme target module already exists with different content',
      file: draft.targetModule,
    };
  }
  proposed[draft.targetModule] = moduleSource;
  const changedFiles = Object.keys(proposed)
    .filter((file) => files[file] !== proposed[file])
    .sort();
  if (changedFiles.length === 0) {
    return {
      status: 'refused',
      reason: 'theme proposal is unchanged',
      file: null,
    };
  }
  return Object.freeze({
    status: 'proposed',
    files: Object.freeze(proposed),
    changedFiles: Object.freeze(changedFiles),
    siteSpansByFile: Object.freeze(siteSpansByFile),
    decisionArtifactHash: approval.artifactHash,
  });
}
