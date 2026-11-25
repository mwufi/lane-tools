/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as adminPage from "../adminPage.js";
import type * as adminPanel from "../adminPanel.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lanes from "../lanes.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_mgmt from "../lib/mgmt.js";
import type * as page from "../page.js";
import type * as provision from "../provision.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  adminPage: typeof adminPage;
  adminPanel: typeof adminPanel;
  crons: typeof crons;
  http: typeof http;
  lanes: typeof lanes;
  "lib/crypto": typeof lib_crypto;
  "lib/mgmt": typeof lib_mgmt;
  page: typeof page;
  provision: typeof provision;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
