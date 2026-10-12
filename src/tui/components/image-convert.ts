/*
Adapted from Pi packages/coding-agent/src/utils/image-convert.ts.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@earendil-works/pi-tui";
import { applyExifOrientation } from "./exif-orientation.ts";

type Photon = typeof import("@silvia-odwyer/photon-node");

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
    const image = applyExifOrientation(photon, rawImage, bytes);
    if (image !== rawImage) rawImage.free();
    try {
      return new Uint8Array(image.get_bytes());
    } finally {
      image.free();
    }
  } catch {
    // Conversion failed
    return null;
  }
}

/**
 * Load photon and return a synchronous PNG transcoder for pi-tui's Kitty image rendering.
 * Returns undefined if photon cannot be loaded.
 */
async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
  const photon = await import("@silvia-odwyer/photon-node").catch(() => undefined);
  if (!photon) return undefined;
  return (base64Data) => {
    const pngBytes = encodePng(photon, new Uint8Array(Buffer.from(base64Data, "base64")));
    return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
  };
}

let pngTranscoderLoad: Promise<boolean> | undefined;
let pngTranscoderRegistered = false;

/**
 * On Kitty-protocol terminals, register photon as pi-tui's image transcoder so non-PNG images render.
 * Loads photon once. `onRegistered` runs after registration so callers can re-render images that
 * showed text fallbacks; it is not called if the transcoder was already registered or cannot load.
 */
export function ensurePngTranscoder(onRegistered: () => void): void {
  if (pngTranscoderRegistered || getCapabilities().images !== "kitty") return;
  pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
    if (!transcoder) return false;
    setImageTranscoder(transcoder);
    pngTranscoderRegistered = true;
    return true;
  });
  void pngTranscoderLoad.then((registered) => {
    if (registered) onRegistered();
  });
}
