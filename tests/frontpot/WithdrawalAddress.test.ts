import { afterEach, expect, it, vi } from "vitest";
import { PlayerWalletView } from "../../src/frontpot/PlayerWalletView";
afterEach(() => vi.useRealTimers());
function setup(address: string) {
  vi.useFakeTimers();
  const api = vi.fn();
  const view = new PlayerWalletView({
    api,
    act: async (fn) => fn(),
    paint: vi.fn(),
    identity: () => null,
    busy: () => false,
    back: vi.fn(),
    signIn: vi.fn(),
    enabled: () => true,
  });
  const state = view as unknown as {
    customDestination: string;
    editingDestination: boolean;
    confirmed: boolean;
  };
  state.customDestination = address;
  state.editingDestination = true;
  state.confirmed = true;
  return { view, state, api };
}
it("validates and locks the trimmed address and requires fresh amount confirmation", () => {
  const { view, state } = setup(" 11111111111111111111111111111111 ");
  view.confirmDestination();
  expect(state.customDestination).toBe("11111111111111111111111111111111");
  expect(state.editingDestination).toBe(false);
  expect(state.confirmed).toBe(false);
});
it("keeps malformed addresses editable", () => {
  const { view, state } = setup("111111111111111111111111111111111");
  expect(() => view.confirmDestination()).toThrow("valid Solana wallet");
  expect(state.editingDestination).toBe(true);
});
it("does not submit a withdrawal while the destination is being edited", async () => {
  const { view, api } = setup("11111111111111111111111111111111");
  await expect(view.withdraw()).rejects.toThrow(
    "Confirm the new withdrawal address",
  );
  expect(api).not.toHaveBeenCalled();
});
