import { useEffect, useRef, useState, type ReactNode } from "react";

type RevealProps = {
  children: ReactNode;
  /** Override the default IntersectionObserver options when a section needs a different cue. */
  threshold?: number;
  rootMargin?: string;
};

/**
 * Reads `prefers-reduced-motion` once at module evaluation. The result is
 * captured up-front (rather than inside a `useEffect`) so the initial
 * `visible` state is correct on the very first paint — flipping it after
 * mount would briefly render the translated/transparent state to users
 * who explicitly opted out of motion.
 */
const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Fades and lifts its child into view the first time the section
 * intersects the viewport. Disconnects the observer immediately after,
 * so each reveal pays for at most one observation cycle.
 *
 * Falls back to immediately visible when `IntersectionObserver` is
 * unavailable (older browsers / SSR snapshots) or when the user prefers
 * reduced motion, so content is never left invisible or animated against
 * their wishes. Setting those fallbacks in the initial state — instead of
 * a `setState` inside an effect — avoids a flash of hidden content.
 */
export function Reveal({ children, threshold = 0.12, rootMargin = "0px 0px -10% 0px" }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => PREFERS_REDUCED_MOTION || typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (PREFERS_REDUCED_MOTION) return;
    if (typeof IntersectionObserver === "undefined") return;
    const node = ref.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold, rootMargin },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [threshold, rootMargin]);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}
