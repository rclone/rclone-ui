const { heroui } = require('@heroui/react')

/** @type {import('tailwindcss').Config} */
export default {
    content: [
        './index.html',
        './src/**/*.{js,ts,jsx,tsx}',
        './lib/**/*.{js,ts,jsx,tsx}',
        './video/**/*.{js,ts,jsx,tsx}',
        './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
    ],
    theme: {
        extend: {
            keyframes: {
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
                'fade-in-up': 'fade-in-up 900ms cubic-bezier(0.22, 1, 0.36, 1)',
                'show-more': 'show-more 2s infinite',
                'show-more-title': 'show-more-title 2s infinite',
            },
        },
    },
    darkMode: 'class',
    plugins: [heroui()],
}
