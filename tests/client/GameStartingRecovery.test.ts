import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));
import { GameStartingModal } from "../../src/client/GameStartingModal";
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});
it("offers a way out of stalled loading and clears the timer on success", async () => {
  vi.useFakeTimers();
  const modal = new GameStartingModal();
  document.body.append(modal);
  modal.show();
  await modal.updateComplete;
  expect(modal.delayed).toBe(false);
  vi.advanceTimersByTime(30000);
  await modal.updateComplete;
  expect(modal.textContent).toContain("Loading is taking longer");
  expect(modal.querySelector('a[href="/lobbies"]')).not.toBeNull();
  modal.hide();
  expect(modal.isVisible).toBe(false);
  modal.show();
  vi.advanceTimersByTime(1000);
  modal.hide();
  vi.advanceTimersByTime(30000);
  expect(modal.delayed).toBe(false);
});
