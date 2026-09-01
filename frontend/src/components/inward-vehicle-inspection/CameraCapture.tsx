"use client";
import { useEffect, useRef, useState } from "react";

/**
 * In-app camera capture for Inward Vehicle Inspection photos -- replaces
 * the plain <input type="file"> upload flow with: open camera -> Capture
 * -> review the shot -> Retake or Use Photo. The stream stays open the
 * whole time (Retake just goes back to showing the live <video>), so
 * there's no re-prompt for camera permission between shots.
 *
 * getUserMedia requires a secure context (HTTPS, or localhost for dev),
 * same constraint as CameraQrScanner. If the camera can't be used at all
 * (no camera, permission denied, insecure context), this falls back to a
 * plain file picker -- same fallback convention as CameraQrScanner falling
 * back to the manual text field.
 */
export default function CameraCapture({
  onCapture, onCancel,
}: {
  onCapture: (file: File) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [shot, setShot] = useState<string | null>(null); // captured frame as a data URL, or null while live

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
      } catch {
        setError("Couldn't access the camera — check permissions, or choose a file below instead.");
      }
    }

    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function handleShoot() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setShot(canvas.toDataURL("image/jpeg", 0.92));
  }

  function handleRetake() {
    setShot(null);
  }

  function handleUsePhoto() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });
        stopStream();
        onCapture(file);
      },
      "image/jpeg",
      0.92
    );
  }

  function handleCancel() {
    stopStream();
    onCancel();
  }

  return (
    <div className="camera-scanner">
      {error ? (
        <>
          <div className="hint-text" style={{ color: "var(--red)", fontWeight: 600 }}>{error}</div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "center" }}>
            <label className="btn btn-secondary" style={{ margin: 0 }}>
              Choose a file
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => e.target.files?.[0] && onCapture(e.target.files[0])}
              />
            </label>
            <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            className="camera-scanner-video"
            style={{ display: shot ? "none" : "block", margin: "0 auto" }}
          />
          {shot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shot} alt="Captured preview" className="camera-scanner-video" style={{ margin: "0 auto" }} />
          )}
          {!ready && !shot && <div className="hint-text">Starting camera…</div>}
          <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "center" }}>
            {shot ? (
              <>
                <button className="btn btn-ghost" onClick={handleRetake}>Retake</button>
                <button className="btn btn-primary" onClick={handleUsePhoto}>Use Photo</button>
              </>
            ) : (
              <>
                <button className="btn btn-primary" disabled={!ready} onClick={handleShoot}>Capture</button>
                <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
              </>
            )}
          </div>
        </>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}
