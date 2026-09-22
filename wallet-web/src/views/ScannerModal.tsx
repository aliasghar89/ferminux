import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Spinner } from '../components/ui.tsx';
import { decodeQrImage, parseQrPayload, type QrTarget } from '../lib/qr.ts';
import { CHAIN_ID } from '../config.ts';

/** ~10 fps. Enough for a hand-held scan, ~6× cheaper than decoding every frame. */
const FRAME_INTERVAL_MS = 100;
/** Longest edge we decode. Downscaling is the single biggest win for battery. */
const MAX_SCAN_EDGE = 480;
/** Longest edge for a still image — stills get more pixels and a slower path. */
const MAX_IMAGE_EDGE = 1400;
/** How long to scan before offering the fallbacks unprompted. */
const DECODE_HINT_MS = 20_000;

type CameraState =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'blocked'; title: string; detail: string; retryable: boolean };

export function ScannerModal({
  onClose,
  onResult,
}: {
  onClose: () => void;
  onResult: (target: QrTarget) => void;
}) {
  const [camera, setCamera] = useState<CameraState>({ kind: 'starting' });
  const [rejected, setRejected] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** Guards against re-reporting the same rejected code 10× a second. */
  const lastPayloadRef = useRef<string | null>(null);
  /** Set once a code is accepted so a late frame cannot fire a second result. */
  const doneRef = useRef(false);

  /** Release the camera. Idempotent — safe to call from cleanup and handlers. */
  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* pausing a torn-down element is not an error */
      }
      video.srcObject = null;
    }
  }, []);

  const accept = useCallback(
    (target: QrTarget) => {
      if (doneRef.current) return;
      doneRef.current = true;
      stopCamera();
      try {
        navigator.vibrate?.(35);
      } catch {
        /* vibration is a nicety, never a requirement */
      }
      onResult(target);
      onClose();
    },
    [onClose, onResult, stopCamera],
  );

  /** One decoded string → either a filled Send form or an honest explanation. */
  const consume = useCallback(
    (payload: string, source: 'camera' | 'image' | 'manual') => {
      const parsed = parseQrPayload(payload, CHAIN_ID);
      if (parsed.ok) {
        setRejected(null);
        setManualError(null);
        accept(parsed.target);
        return true;
      }
      if (source === 'manual') setManualError(parsed.error);
      else setRejected(parsed.error);
      return false;
    },
    [accept],
  );

  /* ---------------- camera ---------------- */

  // The scan loop reaches `consume` through a ref so that a parent re-render
  // (new onResult/onClose identity) can never tear down and re-open the camera
  // mid-scan. Declared before the camera effect so it is synced first.
  const consumeRef = useRef(consume);
  useEffect(() => {
    consumeRef.current = consume;
  }, [consume]);

  useEffect(() => {
    let cancelled = false;
    doneRef.current = false;
    setRejected(null);
    setHintVisible(false);
    lastPayloadRef.current = null;

    const block = (title: string, detail: string, retryable: boolean) => {
      if (!cancelled) setCamera({ kind: 'blocked', title, detail, retryable });
    };

    const scanFrame = () => {
      if (doneRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

      const scale = Math.min(1, MAX_SCAN_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      let frame: ImageData;
      try {
        frame = ctx.getImageData(0, 0, w, h);
      } catch {
        return; // tainted canvas — cannot happen with a same-origin camera stream
      }
      const payload = decodeQrImage(frame.data, w, h, { inversionAttempts: 'dontInvert' });
      if (payload === null) return;
      if (payload === lastPayloadRef.current) return; // already rejected this exact code
      lastPayloadRef.current = payload;
      consumeRef.current(payload, 'camera');
    };

    const start = async () => {
      if (typeof navigator === 'undefined' || !window.isSecureContext) {
        block(
          'Camera needs a secure connection',
          'Browsers only expose the camera over HTTPS (or on localhost). Open this wallet at https://wallet.ferminux.net and the scanner will work — or use "Scan from image" below, which works anywhere.',
          false,
        );
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        block(
          'This browser has no camera API',
          'navigator.mediaDevices.getUserMedia is unavailable here — common in older or embedded browsers. Use "Scan from image" or paste the address below.',
          false,
        );
        return;
      }

      setCamera({ kind: 'starting' });
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
          block(
            'Camera permission denied',
            'Your browser blocked camera access for this site. Re-enable it from the padlock (or camera) icon in the address bar → Site settings → Camera → Allow, then reload the page. On iOS: Settings → Safari → Camera → Allow.',
            true,
          );
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
          block(
            'No camera found',
            'This device reports no usable camera. Use "Scan from image" to decode a screenshot or photo of the code instead — it works on desktops with no camera at all.',
            false,
          );
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          block(
            'Camera is busy',
            'Another application is already using the camera. Close it and try again, or use "Scan from image" below.',
            true,
          );
        } else {
          block(
            'Camera could not be started',
            e instanceof Error && e.message ? e.message : 'The browser refused to open a video stream.',
            true,
          );
        }
        return;
      }

      if (cancelled || doneRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay can reject while the element is still mounting; the rAF
           loop below tolerates a not-yet-playing video via readyState */
      }
      if (cancelled) return;
      setCamera({ kind: 'scanning' });

      let lastFrame = 0;
      const loop = (ts: number) => {
        rafRef.current = requestAnimationFrame(loop);
        if (ts - lastFrame < FRAME_INTERVAL_MS) return;
        lastFrame = ts;
        scanFrame();
      };
      rafRef.current = requestAnimationFrame(loop);
    };

    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [attempt, stopCamera]);

  // Nothing decoded for a while → surface the fallbacks rather than let the
  // user stare at a viewfinder that will never fire.
  useEffect(() => {
    if (camera.kind !== 'scanning') return;
    const id = setTimeout(() => setHintVisible(true), DECODE_HINT_MS);
    return () => clearTimeout(id);
  }, [camera.kind, attempt]);

  // Belt and braces: release the camera on unmount even if the effect above
  // was never reached (e.g. an error thrown mid-start).
  useEffect(() => stopCamera, [stopCamera]);

  /* ---------------- still-image fallback ---------------- */

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setRejected(null);
      setImageBusy(true);
      let source: ImageBitmap | HTMLImageElement | null = null;
      let objectUrl: string | null = null;
      try {
        // createImageBitmap decodes the Blob directly — no URL is created, so
        // this path is unaffected by a restrictive `img-src` CSP. The
        // object-URL fallback only exists for browsers that lack it.
        if (typeof createImageBitmap === 'function') {
          source = await createImageBitmap(file);
        } else {
          objectUrl = URL.createObjectURL(file);
          source = await loadImage(objectUrl);
        }
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(source.width, source.height));
        const w = Math.max(1, Math.round(source.width * scale));
        const h = Math.max(1, Math.round(source.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          setRejected('This browser could not open a 2D canvas to read the image.');
          return;
        }
        ctx.drawImage(source, 0, 0, w, h);
        const frame = ctx.getImageData(0, 0, w, h);
        const payload = decodeQrImage(frame.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (payload === null) {
          setRejected(
            'No QR code found in that image. Crop tighter around the code, or paste the address below.',
          );
          return;
        }
        lastPayloadRef.current = payload;
        consume(payload, 'image');
      } catch {
        setRejected('That file could not be opened as an image.');
      } finally {
        if (source && 'close' in source) source.close();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        setImageBusy(false);
        if (fileRef.current) fileRef.current.value = ''; // allow re-picking the same file
      }
    },
    [consume],
  );

  /* ---------------- render ---------------- */

  return (
    <Modal
      title="Scan a payment code"
      onClose={() => {
        stopCamera();
        onClose();
      }}
    >
      <div className="scan-stage" data-state={camera.kind}>
        <video
          ref={videoRef}
          className="scan-video"
          playsInline
          muted
          autoPlay
          aria-label="Camera viewfinder"
          style={{ visibility: camera.kind === 'scanning' ? 'visible' : 'hidden' }}
        />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        {camera.kind === 'scanning' && (
          <div className="scan-reticle" aria-hidden="true">
            <span className="c tl" />
            <span className="c tr" />
            <span className="c bl" />
            <span className="c br" />
          </div>
        )}
        {camera.kind === 'starting' && (
          <div className="scan-overlay">
            <Spinner /> <span>Requesting camera…</span>
          </div>
        )}
        {camera.kind === 'blocked' && (
          <div className="scan-overlay scan-overlay-block">
            <div className="scan-block-title">{camera.title}</div>
            <p className="small muted mb-0">{camera.detail}</p>
            {camera.retryable && (
              <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setAttempt((a) => a + 1)}>
                Try the camera again
              </button>
            )}
          </div>
        )}
      </div>

      {camera.kind === 'scanning' && (
        <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
          Point the rear camera at the code. Ferminux addresses and{' '}
          <span className="mono">ethereum:</span> payment requests for chain {CHAIN_ID} are accepted.
        </p>
      )}

      {hintVisible && camera.kind === 'scanning' && (
        <div className="notice" style={{ marginTop: 6 }}>
          Still nothing. Try more light, hold steadier, or use one of the options below — they work
          without a camera.
        </div>
      )}

      {rejected && (
        <div className="notice notice-danger" role="alert" style={{ marginTop: 12 }}>
          {rejected}
        </div>
      )}

      <hr className="divider" />

      <div className="field">
        <label htmlFor="scan-manual">Or paste an address / payment link</label>
        <div className="input-row">
          <input
            id="scan-manual"
            className={'input input-mono' + (manualError ? ' input-error' : '')}
            placeholder="0x… or ethereum:0x…@3961"
            value={manual}
            onChange={(e) => {
              setManual(e.target.value);
              setManualError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manual.trim() !== '') consume(manual, 'manual');
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn" disabled={manual.trim() === ''} onClick={() => consume(manual, 'manual')}>
            Use
          </button>
        </div>
        {manualError && <div className="field-error">{manualError}</div>}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <button
        className="btn btn-block"
        data-testid="scan-from-image"
        onClick={() => fileRef.current?.click()}
        disabled={imageBusy}
      >
        {imageBusy ? (
          <>
            <Spinner /> Reading image…
          </>
        ) : (
          'Scan from image'
        )}
      </button>
      <div className="field-hint" style={{ textAlign: 'center' }}>
        Decodes a screenshot or photo of a QR code — no camera required.
      </div>
    </Modal>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}
