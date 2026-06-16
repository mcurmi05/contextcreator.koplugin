/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        //warm paper + ink palette (swiss-modern, book-ish). semantic, not raw hex in components.
        paper: { DEFAULT: "#FAF7F2", card: "#FFFFFF", sunk: "#F3EEE6" },
        ink: { DEFAULT: "#1C1917", soft: "#57534E", faint: "#A8A29E" },
        line: { DEFAULT: "#E8E2D9", strong: "#D8D0C4" },
        accent: { DEFAULT: "#C2620B", hover: "#9A4D08", soft: "#FBEAD3", ring: "#E08C2E" },
      },
      fontFamily: {
        sans: ['"Fira Sans"', "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ['"Fira Code"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(28,25,23,0.04), 0 1px 3px rgba(28,25,23,0.06)",
        pop: "0 12px 34px -12px rgba(28,25,23,0.30), 0 2px 8px rgba(28,25,23,0.08)",
      },
      keyframes: {
        pop: {
          "0%": { opacity: "0", transform: "scale(0.94) translateY(4px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        fadein: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
      },
      animation: {
        pop: "pop 180ms cubic-bezier(0.22, 1, 0.36, 1)",
        fadein: "fadein 200ms ease-out",
      },
    },
  },
  plugins: [],
};
