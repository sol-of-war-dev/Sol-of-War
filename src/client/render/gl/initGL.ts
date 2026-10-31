/** WebGL2 initialization with a lower-resolution software fallback for Sol of War. */

import type { WebGLGateStatus } from "../../components/WebGLGate";
import { getPaletteSize } from "./utils/ColorUtils";
import { setSoftwareRendering } from "./utils/Dpr";
import { readRenderer } from "./utils/GlUtils";

export type GLResult =
  | { gl: WebGL2RenderingContext; status: "ok" }
  | { gl: WebGL2RenderingContext; status: "software-ready"; renderer: string }
  | {
      gl: WebGL2RenderingContext;
      status: "limited";
      renderer: string;
      maxTextureSize: number;
    }
  | { gl: null; status: "software" | "unsupported"; renderer: string };

// The renderer unconditionally allocates a PALETTE_SIZE-wide (4096) palette
// texture, so a context whose MAX_TEXTURE_SIZE is below that renders wrong:
// the oversized texImage2D calls fail silently and territory/map areas come
// out black (#4357). In practice this means fingerprinting protection —
// privacy.resistFingerprinting (on by default in LibreWolf, opt-in in
// Firefox) caps MAX_TEXTURE_SIZE at 2048. "limited" still returns the
// context: the player is warned with fix instructions but may continue.
const REQUIRED_TEXTURE_SIZE = getPaletteSize();

// Renderer strings reported by software WebGL backends. Mirrors the detection
// in utilities/Diagnostic.ts.
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software/i;

/** Prefer hardware, but permit software WebGL2 in Sol of War. No browser identity checks. */
export function initGL(
  canvas: HTMLCanvasElement,
  attrs: WebGLContextAttributes = {},
  allowSoftware = !!import.meta.env.VITE_FRONTPOT,
): GLResult {
  const accelerated = canvas.getContext("webgl2", {
    ...attrs,
    failIfMajorPerformanceCaveat: true,
  });
  const gl =
    accelerated ??
    (allowSoftware
      ? canvas.getContext("webgl2", {
          ...attrs,
          failIfMajorPerformanceCaveat: false,
        })
      : null);
  if (gl) {
    const renderer = readRenderer(gl);
    const software = !accelerated || SOFTWARE_RENDERER.test(renderer);
    if (software && !allowSoftware)
      return { gl: null, status: "software", renderer };
    const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    setSoftwareRendering(software);
    if (maxTextureSize < REQUIRED_TEXTURE_SIZE) {
      return { gl, status: "limited", renderer, maxTextureSize };
    }
    return software
      ? { gl, status: "software-ready", renderer }
      : { gl, status: "ok" };
  }
  if (allowSoftware) return { gl: null, status: "unsupported", renderer: "" };
  const probe = document.createElement("canvas").getContext("webgl2");
  return probe
    ? { gl: null, status: "software", renderer: readRenderer(probe) }
    : { gl: null, status: "unsupported", renderer: "" };
}

/**
 * Thrown by the renderer when a supported WebGL2 context cannot be
 * obtained. Carries the detected status + renderer so the caller can gate the
 * user and log the outcome.
 */
export class GLUnavailableError extends Error {
  constructor(
    readonly glStatus: "software" | "unsupported",
    readonly renderer: string,
  ) {
    super(`WebGL2 unavailable: ${glStatus}`);
    this.name = "GLUnavailableError";
  }
}

/**
 * Report the WebGL2 GPU-init outcome to analytics (Google Tag). Fires on every
 * session so we can size the share of users on a software or missing WebGL2
 * context. `renderer` is the unmasked GPU string for non-ok outcomes, empty
 * otherwise.
 */
export function trackGLInit(
  status: "ok" | "software-ready" | "software" | "unsupported" | "limited",
  renderer: string,
  maxTextureSize?: number,
): void {
  window.gtag?.("event", "gl_init", {
    status,
    renderer: status === "ok" ? "" : renderer,
    ...(maxTextureSize !== undefined && {
      max_texture_size: maxTextureSize,
    }),
  });
}

/**
 * Show the full-screen WebGL gate (no GPU-accelerated context). The markup and
 * per-browser fix steps live in the <webgl-gate> Lit component, which is loaded
 * on demand — it's only ever needed in this failure case.
 */
export function showGLGate(status: WebGLGateStatus): void {
  if (document.querySelector("webgl-gate")) {
    return;
  }
  void import("../../components/WebGLGate").then(({ WebGLGate }) => {
    if (document.querySelector("webgl-gate")) {
      return;
    }
    const gate = new WebGLGate();
    gate.status = status;
    document.body.appendChild(gate);
  });
}
