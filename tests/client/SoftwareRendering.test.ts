import { afterEach, expect, it, vi } from "vitest";
import { GPURenderer } from "../../src/client/render/gl/Renderer";
import {
  renderDpr,
  setSoftwareRendering,
} from "../../src/client/render/gl/utils/Dpr";
afterEach(() => {
  setSoftwareRendering(false);
  vi.restoreAllMocks();
});
it("caps software pixels while restoring the normal hardware density", () => {
  vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
  setSoftwareRendering(true);
  expect(renderDpr()).toBe(0.75);
  setSoftwareRendering(false);
  expect(renderDpr()).toBe(2);
});
it("does not queue another software frame while the prior GPU work is pending", () => {
  setSoftwareRendering(true);
  const frame = {};
  const gl = {
    TIMEOUT_EXPIRED: 1,
    SYNC_GPU_COMMANDS_COMPLETE: 2,
    clientWaitSync: vi.fn().mockReturnValue(1),
    deleteSync: vi.fn(),
    fenceSync: vi.fn().mockReturnValue(frame),
    flush: vi.fn(),
  };
  const view = Object.assign(Object.create(GPURenderer.prototype), {
    gl,
    softwareFrame: null,
    uploadTextures: vi.fn(),
    computeTextures: vi.fn(),
    renderFrame: vi.fn(),
  });
  view.draw();
  view.draw();
  expect(view.renderFrame).toHaveBeenCalledTimes(1);
  gl.clientWaitSync.mockReturnValue(0);
  view.draw();
  expect(gl.deleteSync).toHaveBeenCalledWith(frame);
  expect(view.renderFrame).toHaveBeenCalledTimes(2);
});
