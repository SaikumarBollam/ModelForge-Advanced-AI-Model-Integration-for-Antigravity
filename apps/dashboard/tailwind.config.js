/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        forge: {
          50: '#eef7ff', 100: '#d9edff', 200: '#bce0ff', 300: '#8ecdff',
          400: '#59b0ff', 500: '#338dff', 600: '#1b6ef5', 700: '#1458d4',
          800: '#1749ac', 900: '#193f88', 950: '#142a57',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
