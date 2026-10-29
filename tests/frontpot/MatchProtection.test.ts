import { Intent } from "@openfront/engine-api/Schemas";
import { describe, expect, it } from "vitest";
import { GlobalQueue } from "../../src/frontpot/GlobalQueue";
import { advanceLobby } from "../../src/frontpot/LobbyLifecycle";
import {
  defaultQueueSettings,
  MatchTemplateSchema,
} from "../../src/frontpot/QueueSettings";
import { LobbyStore } from "../../src/frontpot/Store";
import { authorizeIntent } from "../../src/server/IntentAuthorization";

describe("Managed match protection", () => {
  it("rejects privileged client controls even for a claimed admin host", () => {
    for (const type of [
      "update_game_config",
      "toggle_game_start_timer",
      "toggle_pause",
      "kick_player",
    ]) {
      expect(
        authorizeIntent(
          { type } as Intent,
          {
            clientID: "abcd1234",
            isAdmin: true,
            isAdminBot: true,
            isLobbyCreator: true,
          },
          {
            managedMatch: true,
            isPublic: false,
            isListed: false,
            isQueued: false,
            hasStarted: false,
          },
        )?.status,
      ).toBe(403);
    }
  });
  it("rejects host-only cheats submitted through custom lobby settings", () => {
    const store = new LobbyStore();
    expect(() =>
      store.create(store.identity("Host"), {
        mode: "ffa",
        stake: "0.1",
        private: true,
        rules: { hostCheats: { infiniteGold: true, infiniteTroops: true } },
      }),
    ).toThrow("valid map and game settings");
  });
  it("normalizes ranked custom settings while preserving permitted spawn and map choices", () => {
    const store = new LobbyStore();
    const host = store.identity("Host");
    const room = store.create(host, {
      mode: "ffa",
      stake: "0.1",
      private: true,
      rules: {
        infiniteGold: true,
        infiniteTroops: true,
        instantBuild: true,
        waterNukes: true,
        startingGold: 10000,
        goldMultiplier: 10,
        donateGold: false,
        donateTroops: false,
        randomSpawn: true,
        gameMapSize: "Compact",
        bots: 0,
        nations: "disabled",
      },
    });
    expect(room.rules).toMatchObject({
      startingGold: 0,
      goldMultiplier: 1,
      donateGold: true,
      donateTroops: true,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      waterNukes: false,
      disabledUnits: [],
      randomSpawn: true,
      gameMapSize: "Compact",
      bots: 100,
    });
    store.updateSettings(host, room.id, {
      mode: "ffa",
      stake: "0.1",
      private: true,
      rules: { ...room.rules, goldMultiplier: 20, donateGold: false },
    });
    expect(room.rules.goldMultiplier).toBe(1);
    expect(room.rules.donateGold).toBe(true);
    expect(room.rulesKey).toBe(JSON.stringify(room.rules));
  });
  it("spreads all six stakes across each automatic wager mode", () => {
    const store = new LobbyStore();
    const queue = new GlobalQueue(store);
    const stakes: Record<string, Set<string>> = {
      ffa: new Set(),
      "1v1": new Set(),
      "2v2": new Set(),
    };
    for (let round = 0; round < 2; round++) {
      queue.replenish();
      for (const room of store.rooms.values())
        if (room.lamports > 0) stakes[room.mode].add(room.stake);
      store.rooms.clear();
    }
    for (const values of Object.values(stakes))
      expect([...values].sort()).toEqual([
        "0.01",
        "0.05",
        "0.1",
        "0.25",
        "0.5",
        "1",
      ]);
  });
  it("bounds queue wagers while preserving custom stakes", () => {
    const template = defaultQueueSettings().templates[0];
    for (const stake of ["0.001", "1.01"])
      expect(
        MatchTemplateSchema.safeParse({ ...template, stake }).success,
      ).toBe(false);
    for (const stake of ["0.01", "1"])
      expect(
        MatchTemplateSchema.safeParse({ ...template, stake }).success,
      ).toBe(true);
    const store = new LobbyStore();
    expect(
      store.create(store.identity("Host"), {
        mode: "1v1",
        stake: "2",
        private: true,
      }).stake,
    ).toBe("2");
  });
  it("allows a host countdown after guests join, prevents extension, and waits for funding", () => {
    const store = new LobbyStore(() => 1000);
    const host = store.identity("Host"),
      guest = store.identity("Guest");
    const room = store.create(host, {
      mode: "1v1",
      stake: "0.1",
      private: true,
    });
    store.join(guest, room.id);
    expect(() => store.requestCountdown(guest, room.id, 30)).toThrow("host");
    for (const seconds of [0, 9, 3601, 12.5, "30"])
      expect(() => store.requestCountdown(host, room.id, seconds)).toThrow(
        "10 to 3600",
      );
    store.requestCountdown(host, room.id, 30);
    expect(room.startsAt).toBe(31000);
    expect(() => store.requestCountdown(host, room.id, 60)).toThrow(
      "cannot be changed",
    );
    const lock = () => {
      throw new Error("Unfunded match locked");
    };
    expect(
      advanceLobby(
        room,
        [host.id, guest.id],
        31000,
        lock,
        [host.id],
        [host.id, guest.id],
      ),
    ).toBe("waiting");
    expect(room.locked).toBeUndefined();
    store.requestCountdown(host, room.id, 10);
    expect(
      advanceLobby(
        room,
        [host.id, guest.id],
        11000,
        () => ({ poolLamports: 200000000, feeLamports: 2000000 }),
        [host.id, guest.id],
      ),
    ).toBe("locked");
    expect(() => store.requestCountdown(host, room.id, 10)).toThrow(
      "already started",
    );
  });
});
