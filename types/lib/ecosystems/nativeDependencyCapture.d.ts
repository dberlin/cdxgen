/**
 * Explicit, source-read-only, network-isolated configure operation. Requires
 * bubblewrap and an installed CMake; the normal facts consumer never calls it.
 * @param {{sourceRoot:string,buildRoot:string,output:string,
 * configureArgs?:string[],command?:string}} options
 * @returns {import("./nativeDependencyFacts.js").NativeDependencyFacts}
 */
export function captureCmakeDependencyFacts(options: {
    sourceRoot: string;
    buildRoot: string;
    output: string;
    configureArgs?: string[];
    command?: string;
}): import("./nativeDependencyFacts.js").NativeDependencyFacts;
/**
 * Configure source-read-only, offline Meson projects and retain introspection.
 * @param {{sourceRoot:string,buildRoot:string,output:string,
 * configureArgs?:string[],command?:string}} options
 * @returns {import("./nativeDependencyFacts.js").NativeDependencyFacts}
 */
export function captureMesonDependencyFacts(options: {
    sourceRoot: string;
    buildRoot: string;
    output: string;
    configureArgs?: string[];
    command?: string;
}): import("./nativeDependencyFacts.js").NativeDependencyFacts;
//# sourceMappingURL=nativeDependencyCapture.d.ts.map