export interface DevnetFixture {
  network: string;
  appId: string;
  ownerPrivateKey: string;
  fundingAddress: string;
  fundingPrivateKey: string;
  treasury: string;
  feePayer: { id: string; address: string };
}
export declare function rehearsalDirectory(
  directory: string,
  create?: boolean,
): Promise<string>;
export declare function privateJSON<T = unknown>(file: string): Promise<T>;
