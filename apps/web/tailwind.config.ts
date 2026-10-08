import type { Config } from 'tailwindcss';
import resolvekit from './tailwind.resolvekit.cjs';

/**
 * Tokens (colours, type scale, radius, shadows, motion) come from the ResolveKit preset; every colour is a
 * CSS variable defined in src/theme/resolvekit-tokens.css (light/dark × teal/indigo).
 */
export default {
  presets: [resolvekit],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      animation: {
        // Slower spinner for long PayPal reads; the preset's `animate-spin` is --dur-spin (800ms).
        'spin-slow': 'rkspin 1.2s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
