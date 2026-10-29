import { GameType } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import { tutorialLobby } from "../../src/frontpot/TutorialGame";

describe("public tutorial", () => {
  it("starts a local guided game without identity, credentials or wager terms", () => {
    const tutorial = tutorialLobby();
    expect(tutorial.gameStartInfo?.config).toMatchObject({
      gameType: GameType.Singleplayer,
      randomSpawn: false,
      difficulty: "Easy",
    });
    expect(tutorial.gameStartInfo?.config.maxTimerValue).toBeUndefined();
    expect(tutorial.gameStartInfo?.players).toHaveLength(1);
    expect(tutorial.playerName).toBe("Commander");
    expect(tutorial.creatorToken).toBeUndefined();
    expect(tutorial.turnstileToken).toBeNull();
    expect(tutorial.gameID).not.toBe(tutorialLobby().gameID);
  });
});
