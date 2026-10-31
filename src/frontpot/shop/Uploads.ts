import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
type Raster = { width: number; height: number; data: Buffer };
const PNG = createRequire(import.meta.url)("pngjs").PNG as {
  sync: { read: (b: Buffer) => Raster; write: (r: Raster) => Buffer };
};
function resize(image: Raster, width: number, height: number): Raster {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const src =
        (Math.min(image.height - 1, Math.floor((y * image.height) / height)) *
          image.width +
          Math.min(image.width - 1, Math.floor((x * image.width) / width))) *
        4;
      image.data.copy(data, (y * width + x) * 4, src, src + 4);
    }
  return { width, height, data };
}
import { InputError } from "../Store";
import { rendererCatalog, type ShopItem } from "./Catalog";
export const CUSTOM_PRICE = "500000";
export const CUSTOM_CATEGORIES = ["flag", "pattern", "skin", "crown"] as const;
export const customURL = (id: string) =>
  `/frontpot/api/shop/custom-art/${id}.png`;
/** Decode bounded raster input, then re-encode: no SVG, URLs, metadata or animation. */
export async function normalizeUpload(input: unknown) {
  const b = input as {
    category?: unknown;
    name?: unknown;
    image?: unknown;
    rights?: unknown;
  } | null;
  if (
    !b ||
    b.rights !== true ||
    !CUSTOM_CATEGORIES.includes(b.category as never) ||
    typeof b.name !== "string" ||
    !/^[\p{L}\p{N} _.-]{1,40}$/u.test(b.name.trim()) ||
    typeof b.image !== "string" ||
    b.image.length > 175000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(b.image)
  )
    throw new InputError(
      "Choose a PNG, a name, and confirm you have permission to use the artwork.",
    );
  const raw = Buffer.from(b.image.split(",")[1], "base64");
  if (
    raw.length > 128 * 1024 ||
    raw.length < 45 ||
    raw.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    raw.toString("ascii", 12, 16) !== "IHDR" ||
    raw.readUInt32BE(8) !== 13
  )
    throw new InputError("Upload a PNG of at most 128 KB.");
  const width = raw.readUInt32BE(16),
    height = raw.readUInt32BE(20);
  if (!width || !height || width > 512 || height > 512)
    throw new InputError("PNG dimensions must be between 1 and 512 pixels.");
  let ended = false;
  const compressed: Buffer[] = [];
  for (let pos = 8; pos < raw.length;) {
    if (pos + 12 > raw.length) throw new InputError("Invalid PNG.");
    const size = raw.readUInt32BE(pos),
      type = raw.toString("ascii", pos + 4, pos + 8);
    if (type === "IHDR" && pos !== 8)
      throw new InputError("Invalid PNG header.");
    if (type === "IDAT") compressed.push(raw.subarray(pos + 8, pos + 8 + size));
    pos += size + 12;
    if (pos > raw.length || type === "acTL")
      throw new InputError("Use a static PNG.");
    if (type === "IEND") {
      ended = pos === raw.length;
      break;
    }
  }
  if (!ended) throw new InputError("Invalid PNG.");
  let image;
  try {
    inflateSync(Buffer.concat(compressed), {
      maxOutputLength: width * height * 8 + height * 8 + 1024,
    });
    image = PNG.sync.read(raw);
  } catch {
    throw new InputError("The PNG could not be decoded.");
  }
  const category = b.category as (typeof CUSTOM_CATEGORIES)[number];
  const scale = Math.min(1, 256 / width, 256 / height);
  const normalized = resize(
    image,
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );
  const png = PNG.sync.write(normalized);
  const id = `custom-${randomBytes(12).toString("hex")}`,
    name = id.replace("-", "_");
  const base = { name, product: null, rarity: "custom" };
  const item: ShopItem = {
    id,
    name: b.name.trim(),
    category,
    collection: "Your uploads",
    tokens: CUSTOM_PRICE,
    rarity: "custom",
    colors: ["#21102e", "#ff9b21"],
    description:
      "Your custom artwork. Permanent account unlock; not transferable.",
    slot:
      category === "skin" || category === "pattern" ? "territory" : category,
    cosmetic: { ...base, url: customURL(id) },
  };
  if (category === "pattern") {
    const pixels = resize(normalized, 32, 32).data,
      bytes = Buffer.alloc(131);
    bytes[1] = (30 << 3) | 2;
    bytes[2] = 30 << 2;
    for (let i = 0; i < 1024; i++)
      if (
        pixels[i * 4 + 3] >= 128 &&
        (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3 >= 128
      )
        bytes[3 + (i >> 3)] |= 1 << (i & 7);
    item.colorPalette = {
      name: `${name}_palette`,
      primaryColor: item.colors[0],
      secondaryColor: item.colors[1],
    };
    item.cosmetic = {
      ...base,
      pattern: bytes.toString("base64url"),
      colorPalettes: [{ name: item.colorPalette.name, isArchived: false }],
    };
    item.description =
      "Your artwork converted to a 32 × 32 two-color repeating territory pattern. Preview the conversion before buying.";
  }
  rendererCatalog([item]);
  return { item, png, digest: createHash("sha256").update(png).digest("hex") };
}
