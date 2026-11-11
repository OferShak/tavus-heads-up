import QRCode from 'qrcode';
import { useMemo } from 'react';

/**
 * Crisp SVG QR code. Error correction L keeps the Word QR at the lowest density (version 1–2) so a
 * webcam can read it off a forehead from across the room.
 */
export function Qr({ value, level = 'L', className, label }: { value: string; level?: 'L' | 'M'; className?: string; label: string }) {
  const { path, size } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: level });
    const n = qr.modules.size;
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
    }
    return { path: d, size: n };
  }, [value, level]);
  const quiet = 2;
  return (
    <svg
      className={className}
      viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
