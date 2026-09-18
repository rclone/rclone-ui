const { heroui } = require('@heroui/react')

/** @type {import('tailwindcss').Config} */
export default {
    // Two tools share this config from two different working directories: Vite runs in
    // src-frontend, Remotion in src-video, whose compositions render the app's real components
    // and so need the same theme. `relative` resolves the globs against this file instead of the
    // working directory, so both see the same files. The HeroUI theme is listed under both
    // node_modules: npm's hoisting decides which one exists, and a glob that matches nothing
    // costs nothing.
    content: {
        relative: true,
        files: [
            './index.html',
            './src/**/*.{js,ts,jsx,tsx}',
            './lib/**/*.{js,ts,jsx,tsx}',
            '../src-video/**/*.{js,ts,jsx,tsx}',
            './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
            '../node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
        ],
    },
    theme: {
        extend: {
            keyframes: {
                // The login page's icon, corner to corner like a DVD player's logo: two linear
                // tracks with unrelated periods, so the path never repeats soon. 56px = the icon.
                'login-dvd-x': {
                    '0%, 100%': { transform: 'translateX(0)' },
                    '50%': { transform: 'translateX(calc(100vw - 56px))' },
                },
                'login-dvd-y': {
                    '0%, 100%': { transform: 'translateY(0)' },
                    '50%': { transform: 'translateY(calc(100vh - 56px))' },
                },
                'fade-in-up': {
                    '0%': { opacity: '0', transform: 'translateY(24px)' },
                    '60%': { opacity: '1' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                'show-more': {
                    '0%, 100%': {
                        transform: 'translateY(-25%)',
                        timingFunction: 'cubic-bezier(0.8,0,1,1)',
                    },
                    '60%': {
                        transform: 'none',
                        timingFunction: 'cubic-bezier(0,0,0.2,1)',
                    },
                },
                'show-more-title': {
                    '0%, 100%': {
                        transform: 'translateY(5%)',
                        timingFunction: 'cubic-bezier(0.8,0,1,1)',
                    },
                    '60%': {
                        transform: 'none',
                        timingFunction: 'cubic-bezier(0,0,0.2,1)',
                    },
                },
            },
            animation: {
                'login-dvd-x': 'login-dvd-x 13s linear infinite',
                'login-dvd-y': 'login-dvd-y 9s linear infinite',
                'fade-in-up': 'fade-in-up 900ms cubic-bezier(0.22, 1, 0.36, 1)',
                'show-more': 'show-more 2s infinite',
                'show-more-title': 'show-more-title 2s infinite',
            },
        },
    },
    darkMode: 'class',
    plugins: [heroui()],
}
