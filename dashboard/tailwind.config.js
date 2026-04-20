/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#0f172a",
        card: "#1e293b",
        border: "#334155",
        accent: "#22c55e"
      }
    }
  },
  darkMode: "class",
  plugins: []
};
