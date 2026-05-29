type LogoProps = {
  size?: number;
  className?: string;
  /** When true, renders the expressive hero variant with a soft halo. */
  hero?: boolean;
};

const VB = 256;
const RADIUS = 56;

export function Logo({ size = 36, className, hero = false }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VB} ${VB}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Systify logo"
      className={className}
    >
      {hero ? <circle cx={VB / 2} cy={VB / 2} r={VB / 2 - 4} fill="url(#aaLogoHalo)" /> : null}

      <g clipPath="url(#aaLogoClip)">
        {/* Pink lower-left / blue upper-right, split along the diagonal */}
        <path d={`M0 0 L0 ${VB} L${VB} ${VB} Z`} fill="url(#aaLogoPink)" />
        <path d={`M0 0 L${VB} ${VB} L${VB} 0 Z`} fill="url(#aaLogoBlue)" />

        {/* Four modular blocks — one large primary + three smaller, arranged in
            a 2×2-ish grid with gap channels between them that read as interface
            boundaries. The asymmetry conveys hierarchy (core → service → modules)
            while staying abstract enough to work as a brand mark. Fill is
            hard-coded white so the blocks stay high-contrast regardless of the
            parent's text color. */}
        <rect x="40" y="40" width="96" height="96" rx="16" fill="#FFFFFF" />
        <rect x="148" y="40" width="68" height="68" rx="12" fill="#FFFFFF" opacity="0.8" />
        <rect x="148" y="120" width="68" height="96" rx="12" fill="#FFFFFF" opacity="0.6" />
        <rect x="40" y="148" width="96" height="68" rx="12" fill="#FFFFFF" opacity="0.7" />

        {/* Small connector dots in the gap channels hint at data flow between modules */}
        <circle cx="140" cy="88" r="4" fill="#FFFFFF" opacity="0.5" />
        <circle cx="140" cy="182" r="4" fill="#FFFFFF" opacity="0.5" />
        <circle cx="88" cy="140" r="4" fill="#FFFFFF" opacity="0.5" />
        <circle cx="182" cy="112" r="4" fill="#FFFFFF" opacity="0.5" />
      </g>

      <defs>
        <clipPath id="aaLogoClip">
          <rect width={VB} height={VB} rx={RADIUS} />
        </clipPath>
        <linearGradient id="aaLogoPink" x1="0" y1={VB} x2={VB} y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF3B6B" />
          <stop offset="1" stopColor="#B8154A" />
        </linearGradient>
        <linearGradient id="aaLogoBlue" x1={VB} y1="0" x2="0" y2={VB} gradientUnits="userSpaceOnUse">
          <stop stopColor="#3BC8FF" />
          <stop offset="1" stopColor="#1E5BE6" />
        </linearGradient>
        {hero ? <HeroDefs /> : null}
      </defs>
    </svg>
  );
}

function HeroDefs() {
  return (
    <radialGradient
      id="aaLogoHalo"
      cx="0"
      cy="0"
      r="1"
      gradientUnits="userSpaceOnUse"
      gradientTransform={`translate(${VB / 2} ${VB / 2}) scale(${VB / 2 - 4})`}
    >
      <stop stopColor="#FFFFFF" stopOpacity="0.18" />
      <stop offset="0.6" stopColor="#FFFFFF" stopOpacity="0.04" />
      <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
    </radialGradient>
  );
}
