import { afterEach, expect, it, vi } from "vitest";
vi.mock(
  "../../src/client/components/cosmetics/CosmeticRenderCanvas",
  () => ({}),
);
import { CosmeticPreviewModal } from "../../src/client/components/CosmeticPreviewModal";
import type { ResolvedCosmetic } from "../../src/client/Cosmetics";
import { writePatternEntry } from "../../src/client/render/gl/utils/PlayerPalette";
afterEach(() => document.body.replaceChildren());
it("keeps the selected team color across refreshed catalog objects and resets for a different item", async () => {
  const language = document.createElement("lang-selector");
  const translations = {
    "team_colors.red": "Red",
    "territory_patterns.pattern.default": "Default",
  };
  Object.assign(language, {
    translations,
    defaultTranslations: translations,
    currentLang: "en",
  });
  document.body.append(language);
  const modal = new CosmeticPreviewModal();
  const item = {
    type: "skin",
    key: "skin:alloy",
    displayName: "Alloy",
    cosmetic: { name: "alloy", url: "/alloy.svg", rarity: "epic" },
    colorPalette: null,
    relationship: "purchasable",
  } as ResolvedCosmetic;
  modal.resolved = item;
  document.body.append(modal);
  await modal.updateComplete;
  await modal.updateComplete;
  (modal.querySelector('[aria-label="Red"]') as HTMLButtonElement).click();
  await modal.updateComplete;
  expect(
    modal.querySelector('[aria-label="Red"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  modal.resolved = { ...item, cosmetic: { ...item.cosmetic! } };
  await modal.updateComplete;
  await modal.updateComplete;
  expect(
    modal.querySelector('[aria-label="Red"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    (
      modal.querySelector("cosmetic-render-canvas") as HTMLElement & {
        customColors: string[];
      }
    ).customColors,
  ).toEqual(["#eb3333"]);
  modal.resolved = { ...item, key: "skin:different" };
  await modal.updateComplete;
  await modal.updateComplete;
  expect(
    modal.querySelector('[aria-label="Default"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
});
it("keeps full-color custom tiles separate from team-tinted repeating presets", () => {
  const meta = new Float32Array(8),
    data = new Uint8Array(2048);
  writePatternEntry(meta, data, 1, undefined, {
    name: "custom",
    url: "/custom.png",
    repeat: { width: 32, height: 16 },
  });
  expect(Array.from(meta.slice(4, 7))).toEqual([-1, 32, 16]);
  writePatternEntry(meta, data, 1, undefined, {
    name: "preset",
    url: "/preset.svg",
    repeat: { width: 64, height: 64, teamTint: true },
  });
  expect(Array.from(meta.slice(4, 7))).toEqual([-2, 64, 64]);
});
