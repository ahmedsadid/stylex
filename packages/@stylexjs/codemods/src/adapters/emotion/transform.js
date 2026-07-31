/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The Emotion -> StyleX pipeline for one file: detect -> read (adapter),
 * buildIR -> emit (core), rewrite -> registry -> imports (adapter).
 *
 * M5 policy (bail loudly, per site): every convertible css site is rewritten
 * and each unconvertible one is left in place with a
 * `// TODO(stylex-migration): …` marker — the file is no longer skipped
 * wholesale. Genuinely file-level structural issues (a non-namespace stylex
 * import, ≥2 registries, an unconvertible keyframes) still refuse the whole
 * file with stated reasons. Nothing is ever silently dropped or guessed.
 */

import { buildFileIR } from '../../core/buildIR';
import { emitFileIR } from '../../core/emit';
import type {
  EmittedRule,
  EmittedStyle,
  EmittedKeyframes,
} from '../../core/emit';
import { normalizeFileIR } from '../../core/normalize';
import { postprocess } from '../../core/postprocess';
import { lintGate } from '../../core/gates/lint';
import { checkRule } from '../../core/referee';
import { formatTodo, isTodoMarker } from '../../core/todos';
import {
  parseSource,
  printSource,
  parserForFile,
  styleToObjectAst,
  createObjectAst,
  jsxComment,
} from '../../core/rewriter';
import {
  analyzeEmotionWiring,
  removePragma,
  removeCssImport,
  removeUnusedCssConsts,
  insertStylexImport,
  ensureReactImport,
  ensureDefaultImport,
  ensureNamedImport,
  removeStyledImportIfUnused,
} from './imports';
import { detectSites, detectKeyframes, detectExistingRegistry } from './detect';
import { readSite, readKeyframes } from './read';
import type { PlainStyleObject } from './read';
import { rewriteSite } from './rewriteSites';
import { flagStyledUsages } from './styled';
import { detectStyledDefs } from './styledDefs';
import { buildStyledWrapper } from './styledWrapper';
import {
  detectThemeBindings,
  makeThemeResolver,
  dropUnusedThemeBindings,
} from './themeTokens';

export type TransformResult =
  | {
      +status: 'converted',
      +code: string,
      +sites: $ReadOnlyArray<{ +key: string, +cssObject: PlainStyleObject }>,
      +keyframes: $ReadOnlyArray<{
        +framesObject: { +[selector: string]: { +[string]: mixed } },
      }>,
      /** Reasons for each site left in place with a TODO marker (M5). */
      +flags: $ReadOnlyArray<string>,
      /** M13: `defineVars` token names this file referenced (trusted; the
       * caller aggregates them into the skeleton `*.stylex` module). */
      +themeTokens: $ReadOnlyArray<string>,
    }
  | { +status: 'skipped', +reasons: $ReadOnlyArray<string> }
  | { +status: 'unchanged' };

export type TransformOptions = {
  /** Wrap `:hover` in `@media (hover: hover)` (default true). */
  +hoverGuard?: boolean,
  /** Map inline-axis physical properties to logical (default true). */
  +logicalProperties?: boolean,
  /** M13: when set, `theme.<path>` reads convert to `<varsName>.<token>` from
   * `varsImport`. Absent → `useTheme` stays a whole-file blocker. */
  +themeTokens?: { +varsImport: string, +varsName: string } | null,
};

export function transformEmotionFile(
  source: string,
  filename: string = 'file.js',
  options?: TransformOptions,
): TransformResult {
  // Cheap bail before parsing anything. `@emotion/styled` files (M11a/M15a)
  // often don't import `@emotion/react` at all.
  if (
    !source.includes('@emotion/react') &&
    !source.includes('@emotion/styled')
  ) {
    return { status: 'unchanged' };
  }

  const { j, root } = parseSource(source, {
    parser: parserForFile(filename),
  });

  const wiring = analyzeEmotionWiring(j, root);
  if (
    !wiring.hasPragma &&
    !wiring.hasClassicJsx &&
    wiring.cssLocalName == null &&
    wiring.keyframesLocalName == null &&
    wiring.styledLocalName == null &&
    wiring.useThemeLocalName == null
  ) {
    return { status: 'unchanged' };
  }

  // M13: with `themeTokens` configured, `theme.<path>` reads (from
  // `const theme = useTheme()`) convert to `defineVars` token references; the
  // used token names are recorded for the skeleton. Without config, `useTheme`
  // stays a whole-file blocker (theme is unconvertible without a mapping).
  const themeTokens = options?.themeTokens ?? null;
  const usedTokens: Set<string> = new Set();
  let themeResolver: ((node: $FlowFixMe) => $FlowFixMe) | null = null;
  if (wiring.useThemeLocalName != null) {
    if (themeTokens != null) {
      const bindings = detectThemeBindings(j, root, wiring.useThemeLocalName);
      const resolve = makeThemeResolver(bindings, themeTokens.varsName);
      themeResolver = (node: $FlowFixMe) => {
        const t = resolve(node);
        if (t != null) {
          usedTokens.add(t.property);
        }
        return t;
      };
    } else {
      wiring.blockers.push(
        '\'@emotion/react\' import of \'useTheme\' is not convertible yet',
      );
    }
  }

  // Keyframes first, so css sites can reference them by name.
  const kfDetection = detectKeyframes(j, root, wiring.keyframesLocalName);
  const kfReads = kfDetection.sites.map((s) =>
    readKeyframes(s.varName, s.objectNode),
  );

  const detection = detectSites(j, root, wiring.cssLocalName);
  const registryDetection = detectExistingRegistry(j, root);

  // Whole-file refusals: genuinely file-level structural issues (not a single
  // site). Keyframes stay whole-file for now — per-site keyframe flagging is a
  // later slice.
  const wholeFileBlockers = [
    ...wiring.blockers,
    ...detection.blockers,
    ...kfDetection.blockers,
    ...registryDetection.blockers,
    ...kfReads.map((r) => (r.ok ? null : r.blocker)).filter(Boolean),
  ];
  if (wholeFileBlockers.length > 0) {
    return { status: 'skipped', reasons: wholeFileBlockers };
  }

  // M15a: static host `styled()` defs (`styled.tag` / `styled('tag')` with
  // static styles) are converted to a StyleX wrapper below. Whatever styled
  // remains — composition, dynamic, long-tail — is flagged per-site (M11a)
  // AFTER conversion via `flagRemainingStyled`, so a converted def (now a plain
  // component that no longer references `styled`) is not flagged.
  const styledLocalName = wiring.styledLocalName;
  const styledDefs =
    styledLocalName != null ? detectStyledDefs(j, root, styledLocalName) : [];
  const flagRemainingStyled = (): Array<string> =>
    styledLocalName != null ? flagStyledUsages(j, root, styledLocalName) : [];

  // --- Per-site classification: each css site either converts or is flagged
  // with a `// TODO(stylex-migration): …` marker (bail loudly, in place). A
  // styled def is another convertible candidate (`kind: 'styled'`); its css is
  // read exactly like a css-prop object via a synthetic site. ---
  const flags: Array<{ +attrPath: $FlowFixMe, +reason: string }> = [];
  const candidates: Array<
    | { +kind: 'site', +site: $FlowFixMe, +read: $FlowFixMe }
    | { +kind: 'styled', +styledDef: $FlowFixMe, +read: $FlowFixMe },
  > = [];
  for (const site of detection.sites) {
    if (site.kind === 'flagged') {
      flags.push({ attrPath: site.attrPath, reason: site.reason });
      continue;
    }
    if (siteAlreadyFlagged(j, site.attrPath)) {
      continue; // re-run guard: leave a previously-flagged site alone
    }
    const read = readSite(site, kfDetection.names, themeResolver ?? undefined);
    if (read.ok) {
      candidates.push({ kind: 'site', site, read });
    } else {
      flags.push({ attrPath: site.attrPath, reason: read.blocker });
    }
  }
  for (const styledDef of styledDefs) {
    // Read the styled css object exactly like a css-prop object. A synthetic
    // site (no attrPath) makes `nameHint` fall to the component name.
    const read = readSite(
      {
        kind: 'convertible',
        attrPath: null,
        objectNode: styledDef.objectNode,
        tagName: styledDef.componentName.toLowerCase(),
      },
      kfDetection.names,
    );
    // A non-readable styled def stays as-is and is flagged after conversion.
    if (read.ok) {
      candidates.push({ kind: 'styled', styledDef, read });
    }
  }

  // Adapter -> core for the convertible candidates.
  const fileIR = normalizeFileIR(
    {
      rules: buildFileIR(
        candidates.map((c) => ({
          nameHint: c.read.nameHint,
          declarations: c.read.declarations,
        })),
      ).rules,
      keyframes: kfReads.map((r) => {
        if (!r.ok) {
          throw new Error('unreachable: keyframes blockers checked above');
        }
        return r.rule;
      }),
    },
    { logicalProperties: options?.logicalProperties ?? true },
  );

  // L5 Referee, per rule: a conflicting site is flagged, not fatal to the file.
  const convertRules: Array<{ +rule: $FlowFixMe, +candidateIndex: number }> =
    [];
  fileIR.rules.forEach((rule, i) => {
    const checked = checkRule(rule);
    if (checked.ok) {
      convertRules.push({ rule: checked.rule, candidateIndex: i });
      return;
    }
    const candidate = candidates[i];
    if (candidate.kind === 'site') {
      flags.push({
        attrPath: candidate.site.attrPath,
        reason: checked.conflicts[0],
      });
    }
    // A styled def that fails the referee stays unconverted; it is flagged
    // per-site after conversion by `flagRemainingStyled`.
  });

  if (convertRules.length === 0 && kfDetection.sites.length === 0) {
    // Nothing convertible here; flag whatever styled remains (all of it, since
    // no def was converted).
    const styledFlags = flagRemainingStyled();
    if (flags.length === 0 && styledFlags.length === 0) {
      return { status: 'unchanged' };
    }
    // Sites to flag: inject TODOs and keep Emotion.
    for (const flag of flags) {
      injectTodo(j, flag.attrPath, flag.reason);
    }
    return {
      status: 'converted',
      code: printSource({ j, root }),
      sites: [],
      keyframes: [],
      flags: [...flags.map((f) => f.reason), ...styledFlags],
      themeTokens: [...usedTokens],
    };
  }

  const existing = registryDetection.registry;
  const { rules, keyframes, bindings } = emitFileIR(
    {
      rules: convertRules.map((c) => c.rule),
      keyframes: fileIR.keyframes,
    },
    { hoverGuard: options?.hoverGuard ?? true, reservedKeys: existing?.keys },
  );

  // L10 Scoped postprocess (see scopedFix): fixes ONLY our emitted stylex.
  const stylesLocalName =
    existing != null ? existing.varName : pickStylesName(j, root);
  const themeVarsImport =
    usedTokens.size > 0 && themeTokens != null
      ? `import { ${themeTokens.varsName} } from '${themeTokens.varsImport}';`
      : null;
  const fixed = scopedFix(
    j,
    rules,
    keyframes,
    stylesLocalName,
    filename,
    themeVarsImport,
  );
  if (fixed.residualErrors.length > 0) {
    return { status: 'skipped', reasons: fixed.residualErrors };
  }

  // Rewrite converted sites; flag the rest in place. For a dynamic rule, pass
  // the captured source expressions as call args, in the emitted param order.
  let styledConverted = false;
  convertRules.forEach((c, k) => {
    const candidate = candidates[c.candidateIndex];
    if (candidate.kind === 'styled') {
      // Replace `const X = styled…` with the render-verified forwardRef wrapper
      // (M15a). For a dynamic styled (M15b) pass the prop-driven expressions as
      // create-call args, in the emitted param order — the wrapper calls
      // `styles.key(props.color, …)`.
      const { dynamicExprs } = candidate.read;
      const byParam = new Map(dynamicExprs.map((d) => [d.param, d.node]));
      const args = rules[k].params.map((p) => printExpr(j, byParam.get(p)));
      j(candidate.styledDef.path).replaceWith(
        buildStyledWrapper(j, {
          componentName: candidate.styledDef.componentName,
          baseTag: candidate.styledDef.baseTag,
          stylesLocalName,
          styleKey: bindings[k],
          args,
        }),
      );
      styledConverted = true;
      return;
    }
    const { dynamicExprs } = candidate.read;
    const byParam = new Map(dynamicExprs.map((d) => [d.param, d.node]));
    const args = rules[k].params.map((p) => byParam.get(p));
    rewriteSite(j, candidate.site, stylesLocalName, bindings[k], args);
  });
  rewriteKeyframes(j, kfDetection.sites, fixed.keyframesByName);
  for (const flag of flags) {
    injectTodo(j, flag.attrPath, flag.reason);
  }

  if (rules.length > 0 && fixed.createObject != null) {
    if (existing != null) {
      existing.objectNode.properties.push(...fixed.createObject.properties);
    } else {
      // Anchor above the EARLIEST converted statement in source order — a
      // styled wrapper may reference `styles.*` before a later css site does.
      const anchorPath = earliestAnchorPath(
        j,
        root,
        convertRules.map((c) => candidates[c.candidateIndex]),
      );
      insertRegistry(j, root, anchorPath, stylesLocalName, fixed.createObject);
    }
  }
  if (existing == null && (rules.length > 0 || keyframes.length > 0)) {
    insertStylexImport(j, root);
  }
  // M15a: give the emitted wrapper its dependencies, then flag whatever styled
  // remains — converted defs no longer reference `styled`, so only the
  // non-convertible ones (composition, dynamic, long-tail) are flagged. A fully
  // converted file's now-unused `styled` import is dropped.
  if (styledConverted) {
    ensureReactImport(j, root);
    ensureDefaultImport(j, root, 'isPropValid', '@emotion/is-prop-valid');
  }
  // M13: bring in the defineVars import for converted theme tokens and drop the
  // now-unused `useTheme` binding/import.
  const useThemeName = wiring.useThemeLocalName;
  if (usedTokens.size > 0 && themeTokens != null && useThemeName != null) {
    ensureNamedImport(j, root, themeTokens.varsName, themeTokens.varsImport);
    dropUnusedThemeBindings(j, root, useThemeName);
  }
  const styledFlags = flagRemainingStyled();
  removeStyledImportIfUnused(j, root, styledLocalName);
  // Remove Emotion wiring only where it is no longer referenced: flagged css
  // props keep the pragma; a still-used `css`/`keyframes` keeps its import; a
  // `const x = css(...)` whose `css={x}` sites all converted is pruned.
  removeUnusedCssConsts(j, root, wiring.cssLocalName);
  removeCssImport(j, root);
  removePragma(j, root);

  const code = printSource({ j, root });
  // Final safety VERIFY (not fix) over the whole file — catches a merge into a
  // user registry whose own code is lint-dirty; we refuse rather than rewrite.
  const finalLint = lintGate(code, { filename });
  if (!finalLint.ok) {
    return {
      status: 'skipped',
      reasons: finalLint.messages.map(
        (m) => `${m.ruleId ?? 'error'}: ${m.message} (line ${m.line})`,
      ),
    };
  }

  return {
    status: 'converted',
    code,
    sites: convertRules.map((c, k) => ({
      key: bindings[k],
      cssObject: candidates[c.candidateIndex].read.cssObject,
    })),
    keyframes: kfReads.map((kf) => {
      if (!kf.ok) {
        throw new Error('unreachable: keyframes blockers checked above');
      }
      return { framesObject: kf.framesObject };
    }),
    flags: [...flags.map((f) => f.reason), ...styledFlags],
    themeTokens: [...usedTokens],
  };
}

/** Whether a css site was already flagged on a previous run (re-run guard):
 * a TODO comment sibling immediately before its element, or leading on it. */
function siteAlreadyFlagged(j: $FlowFixMe, attrPath: $FlowFixMe): boolean {
  const elementPath = attrPath.parent.parent;
  const parent = elementPath.parent.node;
  const children = Array.isArray(parent.children) ? parent.children : null;
  const leading = (elementPath.node.comments ?? []).some((c: $FlowFixMe) =>
    isTodoMarker(c.value),
  );
  if (leading) {
    return true;
  }
  if (children == null) {
    return false;
  }
  const idx = children.indexOf(elementPath.node);
  for (let i = idx - 1; i >= 0; i--) {
    const sibling = children[i];
    if (sibling.type === 'JSXText' && String(sibling.value).trim() === '') {
      continue;
    }
    return (
      sibling.type === 'JSXExpressionContainer' &&
      sibling.expression?.type === 'JSXEmptyExpression' &&
      (sibling.expression.comments ?? []).some((c: $FlowFixMe) =>
        isTodoMarker(c.value),
      )
    );
  }
  return false;
}

/** Injects a `TODO(stylex-migration): reason` marker at a flagged css site: a
 * braced JSX comment sibling when the element is a JSX child, else a leading
 * block comment on the element (both valid, unlike a bare comment as a child). */
function injectTodo(j: $FlowFixMe, attrPath: $FlowFixMe, reason: string): void {
  const elementPath = attrPath.parent.parent;
  const element = elementPath.node;
  const parent = elementPath.parent.node;
  const text = formatTodo(reason);
  if (
    (parent.type === 'JSXElement' || parent.type === 'JSXFragment') &&
    Array.isArray(parent.children)
  ) {
    const idx = parent.children.indexOf(element);
    parent.children.splice(idx, 0, jsxComment(j, text), j.jsxText('\n'));
  } else {
    element.comments = [
      ...(element.comments ?? []),
      { type: 'CommentBlock', value: text, leading: true, trailing: false },
    ];
  }
}

const STYLEX_IMPORT = "import * as stylex from '@stylexjs/stylex';";

/**
 * Scoped postprocess: build a standalone module of just the emitted stylex
 * (keyframes + create + usage stubs), run StyleX's eslint autofixes on it,
 * and extract the FIXED object expressions. The user's file is never linted,
 * so their pre-existing stylex code cannot be reordered.
 */
function scopedFix(
  j: $FlowFixMe,
  rules: $ReadOnlyArray<EmittedRule>,
  keyframes: $ReadOnlyArray<EmittedKeyframes>,
  stylesLocalName: string,
  filename: string,
  // M13: the `defineVars` import line, so a token value (`color: vars.x`)
  // resolves — strict properties like `color` reject an undefined `vars`.
  themeVarsImport: string | null,
): {
  createObject: $FlowFixMe | null,
  keyframesByName: Map<string, $FlowFixMe>,
  residualErrors: $ReadOnlyArray<string>,
} {
  const lines: Array<string> = [STYLEX_IMPORT];
  if (themeVarsImport != null) {
    lines.push(themeVarsImport);
  }
  for (const kf of keyframes) {
    const framesObject: { [string]: EmittedStyle } = {};
    for (const frame of kf.frames) {
      framesObject[frame.selector] = frame.style;
    }
    lines.push(
      `const ${kf.name} = stylex.keyframes(` +
        `${printExpr(j, styleToObjectAst(j, framesObject))});`,
    );
  }
  if (rules.length > 0) {
    lines.push(
      `const ${stylesLocalName} = stylex.create(` +
        `${printExpr(j, createObjectAst(j, rules))});`,
    );
    // Usage stubs so no-unused stays quiet (real usage is in the JSX). A
    // function-form (dynamic) rule is called with placeholder args.
    for (const rule of rules) {
      const call =
        rule.params.length > 0
          ? `(${rule.params.map(() => '0').join(', ')})`
          : '';
      lines.push(`stylex.props(${stylesLocalName}.${rule.key}${call});`);
    }
  }

  const { code, residualErrors } = postprocess(lines.join('\n'), filename, {
    excludeRules: ['no-unused'],
  });

  const parsed = j(code);
  let createObject: $FlowFixMe | null = null;
  const keyframesByName: Map<string, $FlowFixMe> = new Map();
  parsed.find(j.CallExpression).forEach((path: $FlowFixMe) => {
    const callee = path.node.callee;
    if (
      callee.type !== 'MemberExpression' ||
      callee.object.type !== 'Identifier' ||
      callee.object.name !== 'stylex'
    ) {
      return;
    }
    if (callee.property.name === 'create') {
      createObject = unparenthesize(path.node.arguments[0]);
    } else if (callee.property.name === 'keyframes') {
      const declarator = path.parent.node;
      if (
        declarator.type === 'VariableDeclarator' &&
        declarator.id.type === 'Identifier'
      ) {
        keyframesByName.set(
          declarator.id.name,
          unparenthesize(path.node.arguments[0]),
        );
      }
    }
  });

  return { createObject, keyframesByName, residualErrors };
}

/** Prints a single expression node to source (via a throwaway wrapper). An
 * object literal at statement position is parenthesized to avoid block
 * ambiguity; that grouping is stripped again on the way back out. */
function printExpr(j: $FlowFixMe, node: $FlowFixMe): string {
  return j(j.expressionStatement(node))
    .toSource({ quote: 'single' })
    .replace(/;\s*$/, '');
}

/** Clears any parenthesized-grouping metadata from a node so recast reprints
 * it without redundant parens (the TS parser records it, Flow does not). */
function unparenthesize(node: $FlowFixMe): $FlowFixMe {
  if (node != null && node.extra != null) {
    node.extra.parenthesized = false;
    node.extra.parens = undefined;
  }
  return node;
}

/**
 * Rewrites each `keyframes({...})` call in place to `stylex.keyframes(<fixed
 * object>)`, matched to detected sites by the bound variable name.
 */
function rewriteKeyframes(
  j: $FlowFixMe,
  sites: $ReadOnlyArray<{ +callPath: $FlowFixMe, +varName: string, ... }>,
  fixedByName: Map<string, $FlowFixMe>,
): void {
  for (const site of sites) {
    const framesObject = fixedByName.get(site.varName);
    if (framesObject == null) {
      continue;
    }
    j(site.callPath).replaceWith(
      j.callExpression(
        j.memberExpression(j.identifier('stylex'), j.identifier('keyframes')),
        [framesObject],
      ),
    );
  }
}

/** `styles`, or a numbered variant if the file already uses that name. */
function pickStylesName(j: $FlowFixMe, root: $FlowFixMe): string {
  const taken = (name: string) => root.find(j.Identifier, { name }).size() > 0;
  let name = 'styles';
  for (let n = 2; taken(name); n++) {
    name = `styles${n}`;
  }
  return name;
}

/** Of the convert candidates, the anchor path whose top-level statement appears
 * earliest in the program — so the registry lands above its first user (a
 * styled wrapper can reference `styles.*` before a later css site). */
function earliestAnchorPath(
  j: $FlowFixMe,
  root: $FlowFixMe,
  candidates: $ReadOnlyArray<$FlowFixMe>,
): $FlowFixMe {
  const body = root.get().node.program.body;
  const topLevel = (anchor: $FlowFixMe): $FlowFixMe => {
    let p = anchor;
    while (p.parent != null && p.parent.node.type !== 'Program') {
      p = p.parent;
    }
    return p;
  };
  let best = null;
  let bestIndex = Infinity;
  for (const candidate of candidates) {
    const anchor =
      candidate.kind === 'styled'
        ? candidate.styledDef.path
        : candidate.site.attrPath;
    const index = body.indexOf(topLevel(anchor).node);
    if (index >= 0 && index < bestIndex) {
      bestIndex = index;
      best = anchor;
    }
  }
  return best;
}

/**
 * Inserts `const <styles> = stylex.create({...})` directly above the
 * top-level statement containing the first converted site (per the
 * best-practices doc's registry placement).
 */
function insertRegistry(
  j: $FlowFixMe,
  root: $FlowFixMe,
  anchorPath: $FlowFixMe,
  stylesLocalName: string,
  createObject: $FlowFixMe,
): void {
  const declaration = j.variableDeclaration('const', [
    j.variableDeclarator(
      j.identifier(stylesLocalName),
      j.callExpression(
        j.memberExpression(j.identifier('stylex'), j.identifier('create')),
        [createObject],
      ),
    ),
  ]);

  let statementPath = anchorPath;
  while (
    statementPath.parent != null &&
    statementPath.parent.node.type !== 'Program'
  ) {
    statementPath = statementPath.parent;
  }
  j(statementPath).insertBefore(declaration);
}
