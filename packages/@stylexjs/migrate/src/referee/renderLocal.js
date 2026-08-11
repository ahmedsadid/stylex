/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * The CSS comparison is static-css-v3. This wrapper model additionally claims
 * that the source call is direct, closed, unshadowed, non-escaping, and occurs
 * exactly where the generated stylex.props call occurs.
 */
export const RENDER_LOCAL_CSS_MODEL: string = 'render-local-css-v1';
