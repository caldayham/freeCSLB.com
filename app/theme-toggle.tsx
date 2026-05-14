"use client";

import { useEffect, useState } from "react";

/**
 * Light/dark toggle. The actual `dark` class on <html> is set pre-paint by the
 * inline script in layout.tsx (no flash); this just flips it + persists choice.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-md border border-stone-300 dark:border-stone-700 px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-900 transition"
    >
      {dark ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
