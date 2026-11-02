/** Tailwind v4 ships its own PostCSS plugin; there is no tailwind.config.js —
 *  the theme lives in `src/app/globals.css` under `@theme inline`. */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
