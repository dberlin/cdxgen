/**
 * Merges two CycloneDX dependency arrays into a single deduplicated list.
 * For each unique ref, the dependsOn and provides sets from both arrays are
 * combined. Self-referential entries pointing to the parent component are
 * removed from all dependsOn and provides lists.
 *
 * @param {Object[]} dependencies First array of dependency objects
 * @param {Object[]} newDependencies Second array of dependency objects to merge
 * @param {Object} parentComponent Parent component whose bom-ref is used to filter self-references
 * @returns {Object[]} Merged and deduplicated array of dependency objects
 */
export function mergeDependencies(dependencies: Object[], newDependencies: Object[], parentComponent?: Object): Object[];
/**
 * Marks npm @types packages as excluded from runtime scope.
 *
 * @param {Object[]} components CycloneDX component objects
 * @returns {Object[]} The same component array with scopes updated in place
 */
export function markNpmTypesPackagesAsExcluded(components?: Object[]): Object[];
/**
 * Propagates required scope through a dependency graph.
 *
 * If component A has `scope: "required"` and dependency metadata says A depends
 * on B, B is also runtime-relevant. Keep packages optional when lockfile/parser
 * metadata explicitly identifies them as development, optional, or peer-only.
 *
 * @param {Object[]} components CycloneDX component objects
 * @param {Object[]} dependencies CycloneDX dependency entries
 * @returns {Object[]} The same component array with scopes updated in place
 */
export function propagateRequiredScopeFromDependencies(components?: Object[], dependencies?: Object[]): Object[];
/**
 * Scopes the dependencies of type-only npm packages as optional.
 *
 * A package imported only for its TypeScript types, like an `@types` package,
 * is erased at compile time, and so is what it depends on unless a runtime
 * package depends on it too. A component below a type-only package becomes
 * optional when no dependency path from a root of the graph reaches it without
 * passing through a type-only package. A component that already has a scope,
 * from its manifest or from usage evidence, keeps it.
 *
 * @param {Object[]} components CycloneDX component objects
 * @param {Object[]} dependencies CycloneDX dependency entries
 * @returns {Object[]} The same component array with scopes updated in place
 */
export function markTypeOnlyDependenciesOptional(components?: Object[], dependencies?: Object[]): Object[];
/**
 * Merge CycloneDX services using bom-ref or group/name/version identity.
 *
 * @param {Object[]|Object} services Existing service list
 * @param {Object[]|Object} newServices New service list
 * @returns {Object[]} Merged and deduplicated services
 */
export function mergeServices(services: Object[] | Object, newServices: Object[] | Object): Object[];
/**
 * Native configured providers and explicitly scoped local source copies can
 * share upstream package coordinates. Preserve their instance reference only
 * when the complete normal metadata marker and reference agree. Ordinary
 * inventory retains the existing purl-first identity.
 * @param {{purl?:string,"bom-ref"?:string,properties?:{name:string,value:string}[]}} component
 * @returns {string|undefined}
 */
export function nativeComponentInstanceRef(component: {
    purl?: string;
    "bom-ref"?: string;
    properties?: {
        name: string;
        value: string;
    }[];
}): string | undefined;
/**
 * Trim duplicate components by retaining all the properties
 *
 * @template {object} T
 * @param {T[]} components Components
 * @param {Map<string,string>} [referenceMap] Records discarded refs against the actual retained refs
 *
 * @returns {T[]} Filtered components
 */
export function trimComponents<T extends object>(components: T[], referenceMap?: Map<string, string>): T[];
/**
 * Filter out invalid cryptographic-asset components from a component list.
 * Removes algorithm components without a valid cryptoProperties.oid and
 * certificate components without cryptoProperties.algorithmProperties.
 *
 * @param {Object[] | undefined | null} components Array of CycloneDX components
 * @returns {Object[]} Filtered array with invalid crypto components removed
 */
export function filterInvalidCryptoComponents(components: Object[] | undefined | null): Object[];
/**
 * Method to check if a given dependency tree is partial or not.
 *
 * @param {Array} dependencies List of dependencies
 * @param {Number} componentsCount Number of components
 * @returns {Boolean} True if the dependency tree lacks any non-root parents without children. False otherwise.
 */
export function isPartialTree(dependencies: any[], componentsCount?: number): boolean;
/**
 * Re-compute and set the scope based on the dependency tree
 *
 * @param {Array} pkgList List of components
 * @param {Array} dependencies List of dependencies
 *
 * @returns {Array} Updated list
 */
export function recomputeScope(pkgList: any[], dependencies: any[]): any[];
//# sourceMappingURL=depsUtils.d.ts.map