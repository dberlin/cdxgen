/** Read machine-produced Meson introspection with source AST callsites.
 * No wrap database lookup and no assumption that a declared fallback was used.
 */
export function parseMesonIntrospection({ project, dependencies, options, machines, astFiles, log, sourceRoot, buildRoot, }: {
    project: any;
    dependencies: any;
    options: any;
    machines: any;
    astFiles: any;
    log: any;
    sourceRoot: any;
    buildRoot: any;
}): {
    records: {
        consumer: any;
        request: any;
        applicability: string;
        provider: {
            name: any;
            configuration: any;
            artifacts: never[];
        };
        evidence: never[];
    }[];
    targetProfile: {
        machines: any;
        options: any;
    };
};
/** Check only observed source-file inputs; never execute Meson expressions. */
export function hasUnboundMesonVersionInputs(astFiles: any, sourceRoot: any, provider: any): any;
//# sourceMappingURL=mesonIntrospection.d.ts.map