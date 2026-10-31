/** Original Sol of War artwork. Prices are drafts until checkout is configured. */
export const SHOP_MINT = "4KdB5zg8VuuUKJEk4DvkVZnrT9DJQxvWbjfDRF4cpump";
export const SHOP_ITEMS = [
  {
    id: "ember-standard",
    name: "Ember Standard",
    tokens: "1000",
    rarity: "common",
    colors: ["#21102e", "#ff9b21"],
  },
  {
    id: "violet-vanguard",
    name: "Violet Vanguard",
    tokens: "2500",
    rarity: "rare",
    colors: ["#1b1032", "#c29aff"],
  },
  {
    id: "solar-command",
    name: "Solar Command",
    tokens: "5000",
    rarity: "epic",
    colors: ["#251909", "#ffe19b"],
  },
] as const;
export type ShopItemID = (typeof SHOP_ITEMS)[number]["id"];
export const shopItem = (id: string) =>
  SHOP_ITEMS.find((item) => item.id === id);
export const flagURL = (id: string) => `/frontpot/api/shop/art/${id}.svg?v=1`;
export function flagSVG(id: string) {
  const item = shopItem(id);
  if (!item) throw new Error("Unknown cosmetic");
  const [bg, fg] = item.colors;
  const motif =
    id === "ember-standard"
      ? '<path d="M83 17C91 38 64 43 72 58C60 55 58 44 60 37C38 59 52 91 80 92C109 91 120 60 101 39C105 55 96 62 91 61C100 44 92 28 83 17Z"/>'
      : id === "violet-vanguard"
        ? '<path d="M80 19 110 34 104 65 80 90 56 65 50 34ZM80 36 67 44 70 59 80 72 90 59 93 44Z" fill-rule="evenodd"/>'
        : '<path d="m80 17 10 20 22-3-9 21 9 21-22-3-10 20-10-20-22 3 9-21-9-21 22 3Z"/><circle cx="80" cy="55" r="12" fill="' +
          bg +
          '"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 110"><rect width="160" height="110" fill="${bg}"/><path d="M8 8H152V102H8Z" fill="none" stroke="${fg}" stroke-width="2"/><g fill="${fg}">${motif}</g></svg>`;
}
