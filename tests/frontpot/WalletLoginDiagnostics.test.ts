import { expect, it } from "vitest";
import { classifyWalletLoginError } from "../../scripts/walletLoginDiagnostics";

it("reports fixed diagnostic categories without copying provider payloads", () => {
  const error = Object.assign(
    new Error("token=private-token; Buffer is not defined"),
    {
      name: "ReferenceError",
      code: "private-code",
      accessToken: "private-access-token",
      signature: "private-signature",
    },
  );
  error.stack =
    "private-error-message\n at sign (http://localhost:5312/assets/provider-Abc.js:1:92)\n at secret (http://localhost:5312/?token=private-token:1:2)\n at extension (chrome-extension://private-extension/content.js:1:2)";
  const result = classifyWalletLoginError(error);
  expect(result).toMatchObject([
    {
      name: "ReferenceError",
      code: null,
      reason: "buffer_missing",
      frames: ["assets/provider-Abc.js:1:92"],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("private");
});

it("limits nested causes and handles circular or non-error payloads", () => {
  const error = Object.assign(new Error("Request rejected"), {
    code: 4001,
    cause: null as unknown,
  });
  error.cause = error;
  expect(classifyWalletLoginError(error)).toHaveLength(1);
  expect(classifyWalletLoginError(error)[0]).toMatchObject({
    code: 4001,
    reason: "request_rejected",
  });
  expect(classifyWalletLoginError("private-token")).toEqual([]);
  expect(classifyWalletLoginError(null)).toEqual([]);
  const chain = { cause: { cause: { cause: { message: "private-token" } } } };
  expect(classifyWalletLoginError(chain)).toHaveLength(3);
});
