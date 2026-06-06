import { cn } from "@/lib/utils";

export function ButtonStateText({
  current,
  states,
  className,
}: {
  current: string;
  states: readonly string[];
  className?: string;
}) {
  const labels = states.includes(current) ? states : [...states, current];

  return (
    <span className={cn("grid", className)}>
      <span className="sr-only">{current}</span>
      {labels.map((label) => (
        <span
          key={label}
          aria-hidden="true"
          className={cn("col-start-1 row-start-1", label === current ? "visible" : "invisible")}
        >
          {label}
        </span>
      ))}
    </span>
  );
}
