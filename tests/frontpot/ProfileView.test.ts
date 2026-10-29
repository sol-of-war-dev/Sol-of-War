// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultProfileSettings,
  type PlayerProfile,
} from "../../src/frontpot/ProfileTypes";
import { ProfileView } from "../../src/frontpot/ProfileView";

vi.mock("../../src/client/components/ProfileCard", () => ({}));
afterEach(() => {
  document.body.replaceChildren();
});

async function show(own: boolean, tab: "overview" | "edit" = "overview") {
  const host = document.createElement("div");
  document.body.append(host);
  const profile: PlayerProfile = {
    id: "alice",
    name: "Alice",
    icon: "shield",
    color: "orange",
    bio: "",
    joined: 1,
    own,
    stats: {
      games: 10,
      wins: 6,
      losses: 4,
      winRate: 60,
      streak: 1,
      bestStreak: 3,
      modes: [],
    },
    rankedRatings: [
      {
        mode: "1v1",
        rating: 1000,
        games: 10,
        provisional: false,
        tier: "Gold I",
        wins: 6,
        losses: 4,
      },
    ],
    progress: {
      level: 2,
      prestige: 0,
      legend: false,
      lifetimeXp: 250,
      xpInLevel: 150,
      xpForNext: 300,
      canPrestige: false,
    },
    games: [],
    settings: defaultProfileSettings(),
    finances: {
      network: "simulation",
      wageredLamports: "0",
      paidLamports: "0",
      pendingLamports: "0",
    },
  };
  const view = new ProfileView({
    api: async <T>() => profile as T,
    paint: () => render(view.render(), host),
    identity: () => ({
      id: own ? "alice" : "bob",
      name: own ? "Alice" : "Bob",
      token: "fixture-token",
      expires: Date.now() + 60_000,
    }),
    saveIdentity: vi.fn(),
    signIn: vi.fn(),
    back: vi.fn(),
    replay: vi.fn(),
    mapImage: () => "",
    mapName: (x) => x,
  });
  await view.load(own ? "me" : "alice", tab);
  return host;
}

describe("profile ownership presentation", () => {
  it("keeps account navigation, history, progression and editing available to the owner", async () => {
    const host = await show(true);
    expect(host.querySelector('a[href="/wallet"]')).not.toBeNull();
    const select = (name: string) => {
      const button = [
        ...host.querySelectorAll<HTMLButtonElement>(".sp-tabs button"),
      ].find((b) => b.textContent?.trim() === name);
      expect(button).toBeDefined();
      button!.click();
    };
    select("Games");
    expect(host.textContent).toContain("Recent games");
    select("Progression");
    expect(host.textContent).toContain("Earning XP");
    select("Edit profile");
    expect(host.querySelector("input")).not.toBeNull();
    select("Stats");
    expect(host.textContent).toContain("Your match totals");
  });

  it("shows only stats and ranks to visitors even if an owner-only tab was requested", async () => {
    const host = await show(false, "edit");
    expect(host.textContent).toContain("Results by mode");
    expect(host.textContent).toContain("Ranked");
    expect(host.textContent).toContain("1v1");
    expect(
      host.querySelector(".sp-tabs, .sc-nav, profile-card, input"),
    ).toBeNull();
    for (const label of [
      "Recent games",
      "Earning XP",
      "Your match totals",
      "Edit profile",
      "Level track",
    ])
      expect(host.textContent).not.toContain(label);
  });
});
