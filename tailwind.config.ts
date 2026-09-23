/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    // ---------------------------------------------------------------------
    // dwp.intelligence UI Standard — the scales below REPLACE Tailwind's own
    // (they sit outside `extend` deliberately). That is what enforces the
    // standard globally: every `rounded-xl` in the codebase resolves to 6px,
    // every `shadow-sm` to none, every `font-bold` to weight 500, and every
    // `text-2xl` to the 24px ceiling — without a hex or a magic number in a
    // component. Source: docs/dwp_Intelligence_UI_Consistency_Review.md §5.1.
    // ---------------------------------------------------------------------

    // Five sizes only: 12 / 14 / 16 / 20 / 24. The larger Tailwind names are
    // kept so existing classes still compile, but they all cap at 24px.
    fontSize: {
      "2xs": ["12px", { lineHeight: "16px" }], // 9/10/11px are not in the scale
      xs: ["12px", { lineHeight: "16px" }],
      sm: ["14px", { lineHeight: "20px" }], // body
      base: ["16px", { lineHeight: "24px" }], // app name, sub-app name
      lg: ["20px", { lineHeight: "28px" }], // page title
      xl: ["24px", { lineHeight: "32px" }],
      "2xl": ["24px", { lineHeight: "32px" }],
      "3xl": ["24px", { lineHeight: "32px" }],
      "4xl": ["24px", { lineHeight: "32px" }],
      "5xl": ["24px", { lineHeight: "32px" }],
      "6xl": ["24px", { lineHeight: "32px" }],
    },

    // 400 and 500 only. Every heavier name collapses to 500 so no heading can
    // be bold anywhere in the app.
    fontWeight: {
      thin: "400",
      extralight: "400",
      light: "400",
      normal: "400",
      medium: "500",
      semibold: "500",
      bold: "500",
      extrabold: "500",
      black: "500",
    },

    // 6px throughout, plus the pill. No 8 / 10 / 12 / 16 / 24px radii.
    borderRadius: {
      none: "0px",
      sm: "6px",
      DEFAULT: "6px",
      md: "6px",
      lg: "6px",
      xl: "6px",
      "2xl": "6px",
      "3xl": "6px",
      full: "9999px",
    },

    // No elevation. A hairline does the work a shadow would. `shadow-menu` is
    // the single permitted exception, for menus and floating overlays.
    boxShadow: {
      none: "none",
      "2xs": "none",
      xs: "none",
      sm: "none",
      DEFAULT: "none",
      md: "none",
      lg: "none",
      xl: "none",
      "2xl": "none",
      "3xl": "none",
      inner: "none",
      menu: "0 4px 12px rgba(26, 26, 25, 0.08)",
    },

    borderWidth: {
      DEFAULT: "1px",
      0: "0",
      2: "2px",
    },

    extend: {
      // The eight standard tokens, defined in app/globals.css. The
      // RGB-triplet form is deliberate: the standard's own shell code needs
      // `bg-accent/5` (5% accent fill on an active nav item) and a bare
      // `var(--dwp-accent)` cannot carry a Tailwind opacity modifier.
      colors: {
        // Canonical standard names — use these in new code.
        bg: "rgb(var(--dwp-bg) / <alpha-value>)",
        surface: "rgb(var(--dwp-surface) / <alpha-value>)",
        text: "rgb(var(--dwp-text) / <alpha-value>)",
        muted: "rgb(var(--dwp-muted) / <alpha-value>)",
        accent: "rgb(var(--dwp-accent) / <alpha-value>)",
        border: "rgb(var(--dwp-border) / <alpha-value>)",
        danger: "rgb(var(--dwp-danger) / <alpha-value>)",
        "on-accent": "rgb(var(--dwp-on-accent) / <alpha-value>)",

        // Pre-existing semantic names, now aliases onto the same eight tokens
        // so the whole app inherits the standard palette without a rewrite.
        paper: "rgb(var(--dwp-bg) / <alpha-value>)",
        card: "rgb(var(--dwp-surface) / <alpha-value>)",
        panel: "rgb(var(--dwp-surface) / <alpha-value>)",
        rail: "rgb(var(--dwp-surface) / <alpha-value>)", // no dark chrome
        subtle: "rgb(var(--dwp-bg) / <alpha-value>)", // hover / table header
        quiet: "rgb(var(--dwp-bg) / <alpha-value>)",
        ink: "rgb(var(--dwp-text) / <alpha-value>)",
        "ink-solid": "rgb(var(--dwp-text) / <alpha-value>)",
        line: {
          DEFAULT: "rgb(var(--dwp-border) / <alpha-value>)",
          light: "rgb(var(--dwp-border) / <alpha-value>)",
          strong: "rgb(var(--dwp-text) / <alpha-value>)", // focus = border-text
        },
        body: "rgb(var(--dwp-text) / <alpha-value>)",
        second: "rgb(var(--dwp-muted) / <alpha-value>)",
        label: "rgb(var(--dwp-muted) / <alpha-value>)",

        // The standard carries no green, no blue and no second red: a signal
        // is the accent, or danger. See §3 "Colour" and gap 10.
        positive: {
          DEFAULT: "rgb(var(--dwp-accent) / <alpha-value>)",
          deep: "rgb(var(--dwp-accent-deep) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--dwp-accent) / <alpha-value>)",
          deep: "rgb(var(--dwp-accent-deep) / <alpha-value>)",
        },
        negative: "rgb(var(--dwp-danger) / <alpha-value>)",
        alert: "rgb(var(--dwp-danger) / <alpha-value>)",
        info: {
          DEFAULT: "rgb(var(--dwp-accent) / <alpha-value>)",
          tint: "rgb(var(--dwp-accent-08) / <alpha-value>)",
        },

        // The former blueprint ramp, resolved onto the accent and its tints.
        blueprint: {
          DEFAULT: "rgb(var(--dwp-accent) / <alpha-value>)",
          50: "rgb(var(--dwp-accent-05) / <alpha-value>)",
          100: "rgb(var(--dwp-accent-12) / <alpha-value>)",
          200: "rgb(var(--dwp-accent-25) / <alpha-value>)",
          400: "rgb(var(--dwp-accent) / <alpha-value>)",
          600: "rgb(var(--dwp-accent) / <alpha-value>)",
          700: "rgb(var(--dwp-accent-deep) / <alpha-value>)",
        },
      },

      // Proxima Nova is the brand face; Inter is what is actually licensed and
      // self-hosted here, and is already the face on nine of the twelve fleet
      // apps. Gap 2 in the review is still open, so the stack asks for Proxima
      // Nova first and falls back to Inter today.
      fontFamily: {
        sans: ['"Proxima Nova"', "var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ['"Proxima Nova"', "var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ['"Proxima Nova"', "var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"Proxima Nova"', "var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },

      // Fixed shell geometry from §5.1.
      spacing: {
        sidebar: "240px",
        rail: "56px", // the collapsed icon rail (v1.3)
        topbar: "56px",
        tab: "40px",
      },
    },
  },
  plugins: [],
};
