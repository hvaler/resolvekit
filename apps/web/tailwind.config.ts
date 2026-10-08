import type { Config } from 'tailwindcss';

/** Every colour is a CSS variable defined in src/index.css (light/dark × teal/indigo). */
const token = (name: string) => `var(--${name})`;

const names = [
  'bg', 'surface', 'surface2', 'line', 'line2', 'ink', 'ink2', 'ink3',
  'acc', 'acc-ink', 'acc-soft', 'acc-line',
  'ok', 'ok-soft', 'ok-line', 'warn', 'warn-soft', 'warn-line',
  'bad', 'bad-soft', 'bad-line', 'info', 'info-soft', 'info-line', 'hl',
] as const;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: Object.fromEntries(names.map((n) => [n, token(n)])),
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
      keyframes: {
        rkspin: { to: { transform: 'rotate(360deg)' } },
        rkpulse: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
      },
      animation: {
        rkspin: 'rkspin .8s linear infinite',
        'rkspin-slow': 'rkspin 1.2s linear infinite',
        rkpulse: 'rkpulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
