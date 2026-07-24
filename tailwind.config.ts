/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Themeable "media library" palette (Cloudinary-style console).
      // Values are CSS variables defined in app/globals.css — :root is the
      // light theme, .dark the original dark console. The RGB-triplet form
      // keeps Tailwind's opacity modifiers (e.g. text-ink/40) working.
      colors: {
        paper: "rgb(var(--paper) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        card: "rgb(var(--card) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        rail: "rgb(var(--rail) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        blueprint: {
          DEFAULT: "rgb(var(--blueprint) / <alpha-value>)",
          50: "rgb(var(--blueprint-50) / <alpha-value>)",
          100: "rgb(var(--blueprint-100) / <alpha-value>)",
          200: "rgb(var(--blueprint-200) / <alpha-value>)",
          400: "rgb(var(--blueprint-400) / <alpha-value>)",
          600: "rgb(var(--blueprint-600) / <alpha-value>)",
          700: "rgb(var(--blueprint-700) / <alpha-value>)",
        },
      },
      fontFamily: {
        display: ["var(--font-fraunces)", "serif"],
        body: ["var(--font-montserrat)", "sans-serif"],
        mono: ["var(--font-jetbrains)", "monospace"],
      },
      borderRadius: {
        sm: "3px",
      },
    },
  },
  plugins: [],
};
