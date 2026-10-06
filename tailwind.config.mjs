const config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Brand green keeps the app's existing 50/600/700 values so every
        // existing page renders unchanged; the rest of the scale is new and
        // is used by the landing page and available to the app.
        brand: {
          50: "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
          800: "#166534",
          900: "#14532d",
        },
        // ERP design tokens (Module 82). Values live in globals.css as RGB
        // triplets so light/dark themes swap in one place and opacity
        // modifiers (bg-erp-primary/10) keep working.
        erp: {
          bg: "rgb(var(--erp-bg) / <alpha-value>)",
          surface: "rgb(var(--erp-surface) / <alpha-value>)",
          subtle: "rgb(var(--erp-subtle) / <alpha-value>)",
          border: "rgb(var(--erp-border) / <alpha-value>)",
          text: "rgb(var(--erp-text) / <alpha-value>)",
          muted: "rgb(var(--erp-muted) / <alpha-value>)",
          primary: "rgb(var(--erp-primary) / <alpha-value>)",
          "primary-fg": "rgb(var(--erp-primary-fg) / <alpha-value>)",
          nav: "rgb(var(--erp-nav) / <alpha-value>)",
          "nav-text": "rgb(var(--erp-nav-text) / <alpha-value>)",
          "nav-active": "rgb(var(--erp-nav-active) / <alpha-value>)",
          success: "rgb(var(--erp-success) / <alpha-value>)",
          warning: "rgb(var(--erp-warning) / <alpha-value>)",
          danger: "rgb(var(--erp-danger) / <alpha-value>)",
          info: "rgb(var(--erp-info) / <alpha-value>)",
        },
        // Deep ink used for headings and dark sections on the landing page.
        ink: {
          50: "#f6f8f9",
          100: "#eaeff1",
          200: "#d3dce0",
          300: "#a9b8bf",
          400: "#6f838d",
          500: "#4a5f6a",
          600: "#334650",
          700: "#22333c",
          800: "#15242c",
          900: "#0b1a21",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(11,26,33,0.05), 0 8px 24px -12px rgba(11,26,33,0.12)",
        float: "0 30px 80px -30px rgba(11,26,33,0.35), 0 8px 24px -12px rgba(11,26,33,0.18)",
      },
      keyframes: {
        float: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        rise: {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        float: "float 7s ease-in-out infinite",
        rise: "rise 0.7s cubic-bezier(0.22,1,0.36,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
