export declare function fileConfigPath(env?: NodeJS.ProcessEnv): string;
/**
 * Merge a JSON config file's string values into `env` for keys not already set.
 * Returns the list of keys actually applied. Tolerates a missing/corrupt file.
 */
export declare function loadFileConfig(env?: NodeJS.ProcessEnv, path?: string): string[];
//# sourceMappingURL=fileConfig.d.ts.map