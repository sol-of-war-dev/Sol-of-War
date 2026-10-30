export type FileDigests = Record<string, string>;
export type SourceManifest = {
  schema: 1;
  sourceDigest: string;
  files: FileDigests;
  maps: string;
};
export const sourceRoots: string[];
export const sourceFiles: string[];
export function sha(bytes: string | Uint8Array): string;
export function sourceManifest(root: string): Promise<SourceManifest>;
export function releaseCommit(root: string, declared?: string): string | null;
export function compareSources(
  root: string,
  other: string,
): Promise<{
  match: boolean;
  sourceDigest: string;
  otherDigest: string;
  differences: string[];
}>;
export function writeRelease(root: string): Promise<
  SourceManifest & {
    sourceCommit: string | null;
    runtimeFiles: FileDigests;
    builtFiles: FileDigests;
    builtDigest: string;
  }
>;
