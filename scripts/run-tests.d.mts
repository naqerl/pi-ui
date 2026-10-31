export declare const TEST_FILE_GLOB: string;

export declare function computeTestEnv(
  root: string,
  baseEnv?: NodeJS.ProcessEnv,
): Record<string, string | undefined>;
