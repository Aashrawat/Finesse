/** The original Finesse artwork, shared across the workspace. */
export default function FinesseMark({ className = "" }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt=""
      width={36}
      height={41}
      className={`logo-mark object-contain ${className}`}
      aria-hidden="true"
    />
  );
}
