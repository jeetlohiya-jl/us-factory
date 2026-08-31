"use client";
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Live camera QR scanning — a third input method alongside a USB/Bluetooth
 * HID scanner gun (types into the text field + Enter) and typing/pasting
 * the display ID manually. Opens the device camera (rear camera preferred
 * on phones/tablets via facingMode:"environment"), grabs frames onto an
 * offscreen canvas, and runs jsQR against each frame until it decodes a
 * QR code. On a decode, calls onDetected with the raw payload text — the
 * same string a HID scanner or manual entry would have produced — so it
 * feeds into the exact same resolve/validate path server-side; nothing
 * about how the text arrived is trusted differently.
 *
 * getUserMedia requires a secure context (HTTPS, or localhost for dev).
 * Camera access is opt-in per use (Cancel stops the stream immediately)
 * and every failure mode (no camera, permission denied, insecure context)
 * falls back cleanly to the always-available text input this sits next to.
 */
export default function CameraQrScanner({
  onDetected, onCancel,
}: {
  onDetected: (text: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera access isn't available in this browser (requires HTTPS or localhost).");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setReady(true);
        scanLoop();
      } catch {
        setError("Couldn't access the camera — check permissions, or use the text field below instead.");
      }
    }

    function scanLoop() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" });
      if (code && code.data) {
        onDetected(code.data);
        return; // stop the loop; parent unmounts this component on success
      }
      rafRef.current = requestAnimationFrame(scanLoop);
    }

    start();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="camera-scanner">
      {error ? (
        <div className="hint-text" style={{ color: "var(--red)", fontWeight: 600 }}>{error}</div>
      ) : (
        <>
          <video ref={videoRef} playsInline muted className="camera-scanner-video" />
          {!ready && <div className="hint-text">Starting camera…</div>}
          {ready && <div className="hint-text">Point the camera at the QR code.</div>}
        </>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={onCancel}>Cancel</button>
    </div>
  );
}
