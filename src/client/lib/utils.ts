import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Teach tailwind-merge the six spacing steps so a caller still overrides a base. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ["xs", "sm", "md", "lg", "xl", "2xl"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
