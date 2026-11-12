/** @type {import('tailwindcss').Config} */
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: c('bg'),
        surface: c('surface'),
        surface2: c('surface2'),
        ink: c('ink'),
        muted: c('muted'),
        red: { DEFAULT: c('red'), deep: c('red-deep'), soft: c('red-soft') },
        blue: { DEFAULT: c('blue'), deep: c('blue-deep'), soft: c('blue-soft') },
        gold: c('gold'),
      },
      fontFamily: { jua: ['Jua', 'system-ui', 'sans-serif'] },
      keyframes: {
        pop: { '0%': { transform: 'scale(.6)', opacity: '0' }, '60%': { transform: 'scale(1.12)', opacity: '1' }, '100%': { transform: 'scale(1)' } },
        bounceY: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } },
        wobble: { '0%,100%': { transform: 'rotate(-3deg)' }, '50%': { transform: 'rotate(3deg)' } },
      },
      animation: { pop: 'pop .45s cubic-bezier(.3,1.6,.5,1) both', bounceY: 'bounceY 1.2s ease-in-out infinite', wobble: 'wobble 1.6s ease-in-out infinite' },
    },
  },
  plugins: [],
}
