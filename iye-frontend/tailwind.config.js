/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        base:      '#000000',
        surface:   '#0b0b0d',
        blush:     '#e8c5c8',
        coral:     '#ff2a6d',
        slate:     '#8898aa',
        dim:       '#445566',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'Cascadia Mono', 'Fira Code', 'monospace'],
      },
      backdropBlur: {
        xs: '4px',
      },
    },
  },
  plugins: [],
};
