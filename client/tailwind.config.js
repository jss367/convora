/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            // Theme colors resolve from CSS custom properties so a moderator can
            // recolor a whole discussion at runtime by swapping a single
            // `data-theme` attribute (palettes live in index.css). The
            // `<alpha-value>` placeholder keeps Tailwind's opacity utilities
            // (e.g. bg-opacity-90) working against these variable-backed colors.
            colors: {
                primary: "rgb(var(--color-primary) / <alpha-value>)",
                secondary: "rgb(var(--color-secondary) / <alpha-value>)",
                "primary-dark": "rgb(var(--color-primary-dark) / <alpha-value>)",
            },
            fontFamily: {
                sans: [
                    "Inter",
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
        },
    },
    plugins: [],
}
