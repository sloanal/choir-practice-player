import { goBack, previousRoute, type Route } from "../hooks/useHashRoute";

/**
 * Back button that returns to whichever page the user came from, falling back
 * to `fallback` when the page was opened directly.
 */
export function BackButton({
  fallback,
  fallbackLabel,
}: {
  fallback: Route;
  fallbackLabel: string;
}) {
  const prev = previousRoute();
  return (
    <button className="back" onClick={() => goBack(fallback)}>
      ← {prev ? labelFor(prev, fallback, fallbackLabel) : fallbackLabel}
    </button>
  );
}

function labelFor(prev: Route, fallback: Route, fallbackLabel: string): string {
  if (sameRoute(prev, fallback)) return fallbackLabel;
  if (prev.name === "home") return "All songs";
  if (prev.name === "bits") return "Bits & Bobs";
  return "Back";
}

function sameRoute(a: Route, b: Route): boolean {
  return a.name === b.name && ("id" in a ? a.id : "") === ("id" in b ? b.id : "");
}
