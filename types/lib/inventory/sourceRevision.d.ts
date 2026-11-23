/** Nearest actual Git checkout boundary, including nested repositories. */
export declare function sourceRootOf(manifest: string): string | undefined;
/**
 * One observed repository metadata snapshot per generation and external-helper
 * epoch. Tracked inputs must remain fixed during analysis; no persistent cache.
 */
export declare function sourceRevisionOf(manifest: string): {
    version: string;
    repository: string | undefined;
    root: string;
    subpath: string;
    manifest: string;
} | undefined;
