"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Track an element's rendered width so SVG charts can draw in real pixels
 * (text stays legible on phones instead of being scaled down).
 */
export function useWidth<T extends HTMLElement>(fallback = 1040) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
