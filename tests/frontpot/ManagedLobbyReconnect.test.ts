import { GameEnv } from "@openfront/shared/configuration/Env";
import { afterEach, expect, it, vi } from "vitest";
import { cid, makeClient, makeGame, mockWsOf } from "../util/GameServerHarness";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("keeps one seat per account across repeated managed-lobby joins", () => {
  vi.useFakeTimers();
  const game = makeGame({
    managedMatch: true,
    config: { maxPlayers: 2 },
    deps: { env: () => GameEnv.Dev },
  });
  const host = makeClient({ clientID: cid("host"), persistentID: "host" });
  const repeat = makeClient({ clientID: cid("repeat"), persistentID: "host" });
  const opponent = makeClient({
    clientID: cid("opponent"),
    persistentID: "opponent",
  });
  expect(game.joinClient(host)).toBe("joined");
  const originalSocket = mockWsOf(host);
  expect(game.joinClient(repeat)).toBe("joined");
  expect(game.numPlayers()).toBe(1);
  expect(originalSocket.close).toHaveBeenCalledWith(
    1000,
    "kick_reason.duplicate_session",
  );
  expect(game.joinClient(opponent)).toBe("joined");
  expect(game.numPlayers()).toBe(2);
  const refreshed = makeClient({
    clientID: cid("refresh"),
    persistentID: "opponent",
  });
  expect(game.joinClient(refreshed)).toBe("joined");
  expect(game.numPlayers()).toBe(2);
  expect(
    game.joinClient(
      makeClient({ clientID: cid("third"), persistentID: "third" }),
    ),
  ).toBe("rejected");
});
