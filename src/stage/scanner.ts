// Word QR scanner (ADR 0003): reads the QR on the Player's forehead from the Self-view video.
// BarcodeDetector where the browser has it with qr_code support (Chrome on macOS), else zxing-wasm on a
// canvas frame. The wasm is served from our own origin, not the default CDN.

import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export type ScanEngine = 'barcode-detector' | 'zxing-wasm' | 'none';

const SCAN_EVERY_MS = 120;

/** Not in lib.dom yet. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

type Detect = (video: HTMLVideoElement) => Promise<string | null>;

async function barcodeDetector(): Promise<Detect | null> {
  const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    if (!(await Ctor.getSupportedFormats()).includes('qr_code')) return null;
    const det = new Ctor({ formats: ['qr_code'] });
    return async (video) => (await det.detect(video))[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

async function zxing(): Promise<Detect | null> {
  try {
    const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
    // Compile the wasm now, so the first Round's first decode isn't the slow one.
    await prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
      fireImmediately: true,
    });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    return async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const results = await readBarcodes(ctx.getImageData(0, 0, w, h), { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 });
      return results.find((r) => r.isValid)?.text ?? null;
    };
  } catch {
    return null;
  }
}

let enginePromise: Promise<{ engine: ScanEngine; detect: Detect | null }> | null = null;

/** Pick the engine once per page. */
function loadEngine() {
  enginePromise ??= (async () => {
    const bd = await barcodeDetector();
    if (bd) return { engine: 'barcode-detector' as const, detect: bd };
    const zx = await zxing();
    if (zx) return { engine: 'zxing-wasm' as const, detect: zx };
    return { engine: 'none' as const, detect: null };
  })();
  return enginePromise;
}

export interface Scanner {
  stop(): void;
}

/**
 * Scan `video` every ~120ms, never overlapping detections. Raw video frames are not mirrored (the
 * Self-view mirror is CSS only), so the QR reads the right way round.
 */
export function startScanner(
  video: HTMLVideoElement,
  onPayload: (payload: string) => void,
  onEngine?: (engine: ScanEngine) => void,
): Scanner {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  void loadEngine().then(({ engine, detect }) => {
    onEngine?.(engine);
    if (stopped || !detect) return;
    const tick = async () => {
      if (stopped) return;
      const started = performance.now();
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          const payload = await detect(video);
          if (payload && !stopped) onPayload(payload);
        } catch {
          // A bad frame; try the next one.
        }
      }
      if (!stopped) timer = setTimeout(tick, Math.max(0, SCAN_EVERY_MS - (performance.now() - started)));
    };
    void tick();
  });

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** Warm the engine (wasm download/compile) before the first Round needs it. */
export function preloadScanner(onEngine?: (engine: ScanEngine) => void) {
  void loadEngine().then(({ engine }) => onEngine?.(engine));
}
