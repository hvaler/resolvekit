// ResolveKit · Tailwind v3 preset (theme.extend). Values reference the CSS variables in resolvekit-tokens.css.
// Usage: tailwind.config.ts lists it in `presets`. Copied from the design handoff (tokens/tailwind.resolvekit.js), unchanged.
// Note: colours are hex inside var(), so opacity modifiers (bg-acc/50) don't apply. Use the -soft / -line tokens instead.
/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface2)' },
        line: { DEFAULT: 'var(--line)', 2: 'var(--line2)' },
        ink: { DEFAULT: 'var(--ink)', 2: 'var(--ink2)', 3: 'var(--ink3)' },
        acc: { DEFAULT: 'var(--acc)', ink: 'var(--acc-ink)', soft: 'var(--acc-soft)', line: 'var(--acc-line)' },
        ok: { DEFAULT: 'var(--ok)', soft: 'var(--ok-soft)', line: 'var(--ok-line)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)', line: 'var(--warn-line)' },
        bad: { DEFAULT: 'var(--bad)', soft: 'var(--bad-soft)', line: 'var(--bad-line)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)', line: 'var(--info-line)' },
        hl: 'var(--hl)',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        display: ['24px', { lineHeight: '1.1', letterSpacing: '-0.01em', fontWeight: '600' }],
        'title-lg': ['22px', { lineHeight: '1.2', letterSpacing: '-0.01em', fontWeight: '600' }],
        title: ['18px', { lineHeight: '1.25', letterSpacing: '-0.01em', fontWeight: '600' }],
        'heading-md': ['15px', { lineHeight: '1.3', fontWeight: '600' }],
        'heading-sm': ['14px', { lineHeight: '1.3', fontWeight: '600' }],
        'body-lg': ['14px', { lineHeight: '1.55' }],
        body: ['13px', { lineHeight: '1.45' }],
        label: ['12.5px', { lineHeight: '1.4' }],
        caption: ['11.5px', { lineHeight: '1.35' }],
        eyebrow: ['10.5px', { lineHeight: '1', letterSpacing: '0.08em', fontWeight: '600' }],
        'mono-id': ['12.5px', { lineHeight: '1.3', fontWeight: '500' }],
        'mono-frag': ['12px', { lineHeight: '1.5' }],
        'mono-code': ['10.5px', { lineHeight: '1.3' }],
        'mono-tag': ['9px', { lineHeight: '1', fontWeight: '500' }],
      },
      borderRadius: {
        xs: 'var(--radius-xs)', sm: 'var(--radius-sm)', md: 'var(--radius-md)', lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)', '2xl': 'var(--radius-2xl)', '3xl': 'var(--radius-3xl)', pill: 'var(--radius-pill)',
      },
      boxShadow: {
        ring: 'var(--shadow-ring)', float: 'var(--shadow-float)', toast: 'var(--shadow-toast)', modal: 'var(--shadow-modal)',
        'rule-ok': 'inset 3px 0 0 var(--ok-line)', 'rule-warn': 'inset 3px 0 0 var(--warn)',
        'rule-bad': 'inset 3px 0 0 var(--bad)', 'rule-info': 'inset 3px 0 0 var(--info-line)', 'rule-acc': 'inset 3px 0 0 var(--acc)',
      },
      transitionDuration: {
        instant: '150ms', fast: '200ms', base: '300ms', reveal: '500ms', strike: '900ms', status: '1200ms',
      },
      transitionTimingFunction: { standard: 'ease', pulse: 'ease-in-out' },
      keyframes: {
        rkspin: { to: { transform: 'rotate(360deg)' } },
        rkpulse: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '.35' } },
      },
      animation: {
        spin: 'rkspin 800ms linear infinite',
        pulse: 'rkpulse 1600ms ease-in-out infinite',
      },
      outlineColor: { focus: 'var(--acc)' },
    },
  },
};
// Spacing uses Tailwind's default 4px scale. ResolveKit steps: 0.5(2) 1(4) 1.5(6) 2(8) 2.5(10) 3(12) 3.5(14) 4(16) 5(20) 6(24) 7(28) 8(32) 10(40).
// Reduced motion: pair every transition with motion-reduce:transition-none, and every animation with motion-reduce:animate-none.
