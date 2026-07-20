export {};

declare global {
  interface Window {
    OCRAD?: (image: HTMLCanvasElement | CanvasRenderingContext2D | ImageData) => string;
  }
}
