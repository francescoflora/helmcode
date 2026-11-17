const grip = "M30 15.5v-1.7c0-2-.65-3.6-.65-5.4a2.65 2.65 0 0 1 5.3 0c0 1.8-.65 3.4-.65 5.4v1.7Z";
const spokes = "M32 15.8v32.4M15.8 32h32.4M20.545 20.545l22.91 22.91M20.545 43.455l22.91-22.91";

/** The approved Compatto helm, using a 64 × 64 coordinate system. */
export function HelmShape() {
  return (
    <g fill="currentColor">
      <circle cx="32" cy="32" r="16.2" fill="none" stroke="currentColor" strokeWidth="4.2" />
      <path d={spokes} fill="none" stroke="currentColor" strokeWidth="3.2" />
      <circle cx="32" cy="32" r="5.7" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
        <path key={angle} d={grip} transform={`rotate(${angle} 32 32)`} />
      ))}
    </g>
  );
}
