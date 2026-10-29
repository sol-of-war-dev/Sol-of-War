import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { generateID } from "@openfront/shared/SharedUtil";
import { WireGameStartInfoSchema } from "@openfront/shared/WireSchemas";
import type { LobbyConfig } from "../client/ClientGameRunner";

/** The guided game runs locally, never reserving a multiplayer seat or prize pool. */
export function tutorialLobby(): LobbyConfig {
  const gameID = generateID();
  const playerName = "Commander";
  return {
    gameID,
    playerName,
    playerClanTag: null,
    playerRole: null,
    cosmetics: {},
    turnstileToken: null,
    gameStartInfo: WireGameStartInfoSchema.parse({
      gameID,
      players: [
        {
          clientID: generateID(),
          username: playerName,
          clanTag: null,
          cosmetics: {},
        },
      ],
      lobbyCreatedAt: Date.now(),
      config: {
        gameType: GameType.Singleplayer,
        gameMode: GameMode.FFA,
        gameMap: GameMapType.World,
        gameMapSize: GameMapSize.Normal,
        difficulty: Difficulty.Easy,
        bots: 400,
        nations: "default",
        randomSpawn: false,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        donateGold: false,
        donateTroops: false,
        disabledUnits: [],
      },
    }),
  };
}
