// gifenc ships no types. Only what render.ts uses, from its README.
declare module "gifenc" {
  type Format = "rgb565" | "rgb444" | "rgba4444";
  type Palette = number[][];
  type Encoder = {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: Palette; delay?: number; transparent?: boolean; transparentIndex?: number; repeat?: number; dispose?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  const gifenc: {
    GIFEncoder(): Encoder;
    quantize(rgba: Uint8Array, maxColors: number, options?: { format?: Format; oneBitAlpha?: boolean | number }): Palette;
    applyPalette(rgba: Uint8Array, palette: Palette, format?: Format): Uint8Array;
  };
  export default gifenc;
}
