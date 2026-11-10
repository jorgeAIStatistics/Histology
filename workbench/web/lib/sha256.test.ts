import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256, toHex } from "./sha256";
import { niceScaleBar, normRotation, rectangleFromScreenCorners } from "./geometry";

function nodeHex(b: Uint8Array) {
  return createHash("sha256").update(b).digest("hex");
}

describe("streaming SHA-256 (used for files above the one-call Web Crypto limit)", () => {
  it("matches known vectors", () => {
    expect(new Sha256().update(new Uint8Array()).digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256().update(new TextEncoder().encode("abc")).digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("matches Node and Web Crypto for many lengths and chunkings", async () => {
    for (const n of [1, 55, 56, 63, 64, 65, 127, 128, 1000, 70_001]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      const h = new Sha256();
      for (let off = 0; off < n; off += 777) h.update(data.subarray(off, Math.min(off + 777, n)));
      const ours = h.digestHex();
      expect(ours).toBe(nodeHex(data));
      expect(ours).toBe(toHex(await webcrypto.subtle.digest("SHA-256", data)));
    }
  });
});

describe("annotation geometry", () => {
  it("a screen rectangle on a 0/90/180/270° view stays an axis-aligned level-0 rectangle", () => {
    const corners = [
      { x: 300, y: 100 },
      { x: 300, y: 400 },
      { x: 100, y: 400 },
      { x: 100, y: 100 },
    ];
    for (const rot of [0, 90, 180, 270, -90, 450]) {
      expect(rectangleFromScreenCorners(corners, rot)).toEqual({ type: "rectangle", x: 100, y: 100, width: 200, height: 300 });
    }
  });
  it("on any other rotation it becomes a polygon (API contract)", () => {
    const g = rectangleFromScreenCorners(
      [
        { x: 0, y: 0 },
        { x: 10, y: 1 },
        { x: 9, y: 11 },
        { x: -1, y: 10 },
      ],
      30,
    );
    expect(g.type).toBe("polygon");
  });
  it("normalises rotation", () => {
    expect(normRotation(-90)).toBe(270);
    expect(normRotation(720)).toBe(0);
  });
  it("scale bar picks 1/2/5 × 10^n microns", () => {
    const s = niceScaleBar(2, 120)!; // 2 µm per screen pixel → ~240 µm → 200 µm
    expect(s.microns).toBe(200);
    expect(s.px).toBe(100);
    expect(niceScaleBar(0)).toBeNull();
  });
});
