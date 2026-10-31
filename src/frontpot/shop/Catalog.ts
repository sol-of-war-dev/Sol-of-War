import {
  CosmeticsSchema,
  EffectSchema,
  type ColorPalette,
  type CosmeticPack,
  type Crown,
  type Effect,
  type Flag,
  type Pattern,
  type Skin,
} from "@openfront/shared/CosmeticSchemas";
import type { PlayerCosmetics } from "@openfront/shared/WireSchemas";
/** Original procedural Sol of War artwork. All prices remain drafts. */
export const SHOP_MINT = "4KdB5zg8VuuUKJEk4DvkVZnrT9DJQxvWbjfDRF4cpump";
export const CATEGORIES = {
  flag: "Flags",
  pattern: "Territory patterns",
  skin: "Skins",
  crown: "Crowns",
  effect: "Effects",
  bundle: "Bundles",
} as const;
export type Category = keyof typeof CATEGORIES;
export type ShopItem = {
  id: string;
  name: string;
  category: Category;
  collection: string;
  tokens: string;
  rarity: string;
  colors: readonly [string, string];
  description: string;
  slot?: string;
  members?: string[];
  cosmetic: Flag | Pattern | Skin | Crown | Effect | CosmeticPack;
  colorPalette?: ColorPalette;
};
export const flagURL = (id: string) => `/frontpot/api/shop/art/${id}.svg?v=2`;
const themes = [
  {
    id: "ember",
    name: "Ember",
    flag: "ember-standard",
    flagName: "Ember Standard",
    crown: "Ember Diadem",
    pattern: "Ember Ramparts",
    skin: "Ember Forge",
    rarity: "common",
    colors: ["#21102e", "#ff9b21"] as const,
    flagPrice: 1000,
  },
  {
    id: "violet",
    name: "Violet",
    flag: "violet-vanguard",
    flagName: "Violet Vanguard",
    crown: "Violet Sovereign",
    pattern: "Violet Lattice",
    skin: "Violet Nebula",
    rarity: "rare",
    colors: ["#1b1032", "#c29aff"] as const,
    flagPrice: 2500,
  },
  {
    id: "solar",
    name: "Solar",
    flag: "solar-command",
    flagName: "Solar Command",
    crown: "Solar Regent",
    pattern: "Solar Mosaic",
    skin: "Solar Alloy",
    rarity: "epic",
    colors: ["#251909", "#ffe19b"] as const,
    flagPrice: 5000,
  },
];
const effectKinds = [
  {
    id: "ship-wake",
    label: "Ship Wake",
    effectType: "transportShipTrail",
    slot: "transportShipTrail",
    description: "A colored wake behind your transport ships.",
  },
  {
    id: "missile-trail",
    label: "Missile Trail",
    effectType: "nukeTrail",
    slot: "nukeTrail",
    description: "A colored trail behind your missiles.",
  },
  {
    id: "atom-burst",
    label: "Atom Burst",
    effectType: "nukeExplosion",
    slot: "atom",
    description: "A visual shockwave for atomic detonations.",
  },
  {
    id: "hydro-burst",
    label: "Hydro Burst",
    effectType: "nukeExplosion",
    slot: "hydro",
    description: "A visual shockwave for hydrogen detonations.",
  },
  {
    id: "mirv-burst",
    label: "MIRV Burst",
    effectType: "nukeExplosion",
    slot: "mirvWarhead",
    description: "A visual shockwave for MIRV warhead detonations.",
  },
  {
    id: "city-lights",
    label: "City Lights",
    effectType: "structures",
    slot: "structures",
    description: "Colors your structure icons while your territory is hovered.",
  },
  {
    id: "fleet",
    label: "Fleet",
    effectType: "warship",
    slot: "warship",
    description: "Colors your warships; combat indicators retain priority.",
  },
  {
    id: "rail-convoy",
    label: "Rail Convoy",
    effectType: "train",
    slot: "train",
    description: "Colors your train engines and carriages.",
  },
  {
    id: "rail-lines",
    label: "Rail Lines",
    effectType: "railroad",
    slot: "railroad",
    description: "Colors railroads on your territory.",
  },
] as const;
/** 8x8 original tile in OpenFront's version-0 binary pattern format. */
function patternData(theme: number) {
  const bytes = new Uint8Array(11);
  bytes[1] = (6 << 3) | 2;
  bytes[2] = 6 << 2;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const bit =
        theme === 0
          ? y % 4 === 0 || (x + (y < 4 ? 0 : 4)) % 8 === 0
          : theme === 1
            ? (x + y) % 8 === 0 || (x - y + 8) % 8 === 0
            : x < 4 !== y < 4;
      if (bit) bytes[3 + ((y * 8 + x) >> 3)] |= 1 << ((y * 8 + x) & 7);
    }
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
export const SHOP_ITEMS: ShopItem[] = themes.flatMap((t, index) => {
  const base = (id: string) => ({
    name: id.replace(/-/g, "_"),
    product: null,
    rarity: t.rarity,
    artist: "Sol of War",
    aiDisclosed: true,
  });
  const make = (
    id: string,
    name: string,
    category: Category,
    tokens: number,
    description: string,
    cosmetic: ShopItem["cosmetic"],
    slot?: string,
  ): ShopItem => ({
    id,
    name,
    category,
    collection: t.name,
    tokens: String(tokens),
    rarity: t.rarity,
    colors: t.colors,
    description,
    cosmetic: {
      ...cosmetic,
      name: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    },
    slot,
  });
  const flag = make(
    t.flag,
    t.flagName,
    "flag",
    t.flagPrice,
    "Your commander’s flag, displayed beside their name.",
    { ...base(t.flag), url: flagURL(t.flag) },
    "flag",
  );
  const patternID = `${t.id}-pattern`,
    skinID = `${t.id}-skin`,
    crownID = `${t.id}-crown`;
  const palette = {
    name: `${t.id}_palette`,
    primaryColor: t.colors[0],
    secondaryColor: t.colors[1],
  };
  const pattern = make(
    patternID,
    t.pattern,
    "pattern",
    2000 + index * 1000,
    "A repeating geometric territory pattern. Team colors remain governed by the game renderer.",
    {
      ...base(patternID),
      pattern: patternData(index),
      colorPalettes: [{ name: palette.name, isArchived: false }],
    },
    "territory",
  );
  pattern.colorPalette = palette;
  const skin = make(
    skinID,
    t.skin,
    "skin",
    3000 + index * 1500,
    "An original territory texture. Replaces an equipped pattern.",
    { ...base(skinID), url: flagURL(skinID) },
    "territory",
  );
  const crown = make(
    crownID,
    t.crown,
    "crown",
    2000 + index * 1500,
    "An ornamental crown above your commander’s name.",
    { ...base(crownID), url: flagURL(crownID) },
    "crown",
  );
  const effects = effectKinds.map((k) => {
    const id = `${t.id}-${k.id}`;
    const attributes =
      k.effectType === "nukeExplosion"
        ? {
            type: "shockwave",
            nukeType: k.slot,
            colors: [t.colors[1], "#ffffff", t.colors[0]],
            size: k.slot === "hydro" ? 180 : 100,
            speed: 100,
            thickness: 3,
            transitionSpeed: 0.4,
          }
        : {
            type: "gradient",
            colors: [t.colors[1], t.colors[0], t.colors[1]],
            colorSize: 8,
            movementSpeed: 0.6,
          };
    return make(
      id,
      `${t.name} ${k.label}`,
      "effect",
      1500 + index * 1000,
      k.description,
      EffectSchema.parse({ ...base(id), effectType: k.effectType, attributes }),
      `effect:${k.slot}`,
    );
  });
  const singles = [flag, pattern, skin, crown, ...effects];
  const id = `${t.id}-collection`;
  const bundle = make(
    id,
    `${t.name} Collection`,
    "bundle",
    12000 + index * 8000,
    "All 13 cosmetics in this collection. Equip each included item separately.",
    {
      name: id.replace(/-/g, "_"),
      displayName: `${t.name} Collection`,
      description: "13 permanent cosmetic unlocks",
      priceHard: 0,
      rarity: t.rarity,
      items: singles.map((i) => ({
        type: i.category as "flag" | "pattern" | "skin" | "crown" | "effect",
        name: i.cosmetic.name,
        ...(i.colorPalette ? { colorPalette: i.colorPalette.name } : {}),
      })),
    },
  );
  bundle.members = singles.map((i) => i.id);
  return [...singles, bundle];
});
export type ShopItemID = string;
export const shopItem = (id: string) => SHOP_ITEMS.find((i) => i.id === id);
export const purchaseItems = (id: string): string[] => {
  const item = shopItem(id);
  if (!item) throw new Error("Unknown cosmetic");
  return [id, ...(item.members ?? [])];
};
/** Authoritative renderer catalog; no OpenFront commerce or asset endpoints. */
export function rendererCatalog(items: ShopItem[] = SHOP_ITEMS) {
  const result = {
    patterns: {},
    flags: {},
    skins: {},
    crowns: {},
    colorPalettes: {},
    effects: {},
    packs: {},
  } as Record<string, Record<string, unknown>>;
  for (const item of items) {
    if (item.category === "effect") {
      const e = item.cosmetic as Effect;
      const group = (result.effects[e.effectType] ??= {}) as Record<
        string,
        unknown
      >;
      group[e.name] = e;
    } else
      result[item.category === "bundle" ? "packs" : `${item.category}s`][
        item.cosmetic.name
      ] = item.cosmetic;
    if (item.colorPalette)
      result.colorPalettes[item.colorPalette.name] = item.colorPalette;
  }
  return CosmeticsSchema.parse(result);
}
export function resolvedAppearance(items: ShopItem[]): PlayerCosmetics {
  const out: PlayerCosmetics = {};
  for (const item of items) {
    if (item.category === "flag") out.flag = (item.cosmetic as Flag).url;
    else if (item.category === "crown")
      out.crown = {
        name: item.cosmetic.name,
        url: (item.cosmetic as Crown | Skin).url,
      };
    else if (item.category === "skin")
      out.skin = {
        name: item.cosmetic.name,
        url: (item.cosmetic as Crown | Skin).url,
      };
    else if (item.category === "pattern")
      out.pattern = {
        name: item.cosmetic.name,
        patternData: (item.cosmetic as Pattern).pattern,
        colorPalette: item.colorPalette,
      };
    else if (item.category === "effect") {
      const e = item.cosmetic as Effect;
      (out.effects ??= {})[item.slot!.slice(7)] = {
        name: e.name,
        effectType: e.effectType,
      };
    }
  }
  return out;
}
export function flagSVG(id: string) {
  const item = shopItem(id);
  if (!item) throw new Error("Unknown cosmetic");
  const [bg, fg] = item.colors,
    theme = themes.findIndex((t) => t.name === item.collection);
  if (item.category === "crown") {
    const crowns = [
      "M22 70 15 28 48 47 80 15 112 47 145 28 138 70Z",
      "M20 70 24 24 52 43 80 10 108 43 136 24 140 70Z",
      "M20 70 12 35 47 44 60 17 80 38 100 17 113 44 148 35 140 70Z",
    ];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><path d="${crowns[theme]}" fill="${fg}" stroke="${bg}" stroke-width="4"/><rect x="23" y="71" width="114" height="12" rx="4" fill="${fg}"/><path d="m80 44 9 11-9 11-9-11Z" fill="${bg}"/></svg>`;
  }
  if (item.category === "skin") {
    const texture =
      theme === 0
        ? `<path d="M0 16H64M0 48H64M16 0V16M48 16V48M16 48V64" stroke="${fg}" stroke-opacity=".32" stroke-width="2"/>`
        : theme === 1
          ? `<circle cx="16" cy="16" r="14" fill="${fg}" opacity=".16"/><circle cx="48" cy="48" r="20" fill="${fg}" opacity=".23"/><path d="m0 64 64-64M0 32 32-32M32 96 64-64" stroke="${fg}" opacity=".18"/>`
          : `<path d="m0 0 32 16L64 0v32L32 48 0 32Zm0 32 32 16 32-16v32H0Z" fill="${fg}" opacity=".16"/><path d="m0 0 32 16L64 0M0 32l32 16 32-16M32 16v32" fill="none" stroke="${fg}" opacity=".35"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><pattern id="tile" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" fill="${bg}"/>${texture}</pattern></defs><rect width="256" height="256" fill="url(#tile)"/></svg>`;
  }
  const motif =
    theme === 0
      ? '<path d="M83 17C91 38 64 43 72 58C60 55 58 44 60 37C38 59 52 91 80 92C109 91 120 60 101 39C105 55 96 62 91 61C100 44 92 28 83 17Z"/>'
      : theme === 1
        ? '<path d="M80 19 110 34 104 65 80 90 56 65 50 34ZM80 36 67 44 70 59 80 72 90 59 93 44Z" fill-rule="evenodd"/>'
        : `<path d="m80 17 10 20 22-3-9 21 9 21-22-3-10 20-10-20-22 3 9-21-9-21 22 3Z"/><circle cx="80" cy="55" r="12" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 110"><rect width="160" height="110" fill="${bg}"/><path d="M8 8H152V102H8Z" fill="none" stroke="${fg}" stroke-width="2"/><g fill="${fg}">${motif}</g></svg>`;
}
