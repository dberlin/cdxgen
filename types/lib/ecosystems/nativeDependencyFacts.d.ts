/** Build-language input inventory, including dormant declarations. */
export function nativeSourceInputPaths(sourceRoot: any, tool: any): any[];
/**
 * Read only: importing facts never configures, downloads, installs or probes.
 * @param {string} path
 * @param {string} sourceRoot
 * @param {{cmakeCache?:string,nativeDependencyTargetProfile?:object}} [options]
 * @returns {(NativeDependencyFacts & {valid:true,diagnostics:string[]}) |
 * {valid:false,records:[],diagnostics:string[]}}
 */
export function readNativeDependencyFacts(path: string, sourceRoot: string, options?: {
    cmakeCache?: string;
    nativeDependencyTargetProfile?: object;
}): (NativeDependencyFacts & {
    valid: true;
    diagnostics: string[];
}) | {
    valid: false;
    records: [];
    diagnostics: string[];
};
/**
 * Exact executed callsites only; a cache-wide package name is never a key.
 * @param {ReturnType<typeof readNativeDependencyFacts>} facts
 * @param {{requestedName:string,file:string,line:number,command:string,role:string,
 * constraints?:string}} requirement
 * @returns {NativeDependencyRecord|undefined}
 */
export function resolveNativeRequirement(facts: ReturnType<typeof readNativeDependencyFacts>, requirement: {
    requestedName: string;
    file: string;
    line: number;
    command: string;
    role: string;
    constraints?: string;
}): NativeDependencyRecord | undefined;
/**
 * Mutate only unambiguous requirement components and rewrite every graph edge.
 * @param {object[]} components
 * @param {{ref:string,dependsOn?:string[],provides?:string[]}[]} dependencies
 * @param {ReturnType<typeof readNativeDependencyFacts>} facts
 * @returns {number} Number of unambiguously selected requirement components
 */
export function applyNativeDependencyFacts(components: object[], dependencies: {
    ref: string;
    dependsOn?: string[];
    provides?: string[];
}[], facts: ReturnType<typeof readNativeDependencyFacts>): number;
/**
 * @typedef {{path:string, realPath:string, sha256:string}} NativeFileFingerprint
 * @typedef {{tool:"cmake"|"meson", sourceRoot:string, buildRoot:string,
 * cacheFile:string, targetProfile:object, configureArguments:string[],
 * providerSelectionUnchanged?:boolean, id:string}} NativeDependencyConfiguration
 * @typedef {{consumer:{file:string,line:number,command:string},
 * request:{name:string,constraints:string,arguments:string[]},
 * applicability:"selected"|"not-found"|"disabled"|"unknown",
 * provider:{name:string,configuration:string,config?:string,source?:string,
 * type?:string,artifacts:string[]},
 * observedVersion?:{value:string,kind:"release"|"source-revision"|"archive-revision"},
 * evidence:string[]}} NativeDependencyRecord
 * @typedef {{format:"native-dependency-resolution-v1",
 * configuration:NativeDependencyConfiguration, sourceInputs:string[],
 * providerTrees:{root:string,files:string[]}[], inputs:NativeFileFingerprint[],
 * evidence:NativeFileFingerprint[], capture:{kind:string,path:string,
 * traceFile?:string,rawOutput?:string,astFiles?:Record<string,string>},
 * records:NativeDependencyRecord[]}} NativeDependencyFacts
 */
export const NATIVE_FACTS_FORMAT: "native-dependency-resolution-v1";
export function nativeFactsHash(value: any): any;
export function nativeFileFingerprint(path: any): {
    path: any;
    realPath: any;
    sha256: any;
};
export type NativeFileFingerprint = {
    path: string;
    realPath: string;
    sha256: string;
};
export type NativeDependencyConfiguration = {
    tool: "cmake" | "meson";
    sourceRoot: string;
    buildRoot: string;
    cacheFile: string;
    targetProfile: object;
    configureArguments: string[];
    providerSelectionUnchanged?: boolean;
    id: string;
};
export type NativeDependencyRecord = {
    consumer: {
        file: string;
        line: number;
        command: string;
    };
    request: {
        name: string;
        constraints: string;
        arguments: string[];
    };
    applicability: "selected" | "not-found" | "disabled" | "unknown";
    provider: {
        name: string;
        configuration: string;
        config?: string;
        source?: string;
        type?: string;
        artifacts: string[];
    };
    observedVersion?: {
        value: string;
        kind: "release" | "source-revision" | "archive-revision";
    };
    evidence: string[];
};
export type NativeDependencyFacts = {
    format: "native-dependency-resolution-v1";
    configuration: NativeDependencyConfiguration;
    sourceInputs: string[];
    providerTrees: {
        root: string;
        files: string[];
    }[];
    inputs: NativeFileFingerprint[];
    evidence: NativeFileFingerprint[];
    capture: {
        kind: string;
        path: string;
        traceFile?: string;
        rawOutput?: string;
        astFiles?: Record<string, string>;
    };
    records: NativeDependencyRecord[];
};
//# sourceMappingURL=nativeDependencyFacts.d.ts.map