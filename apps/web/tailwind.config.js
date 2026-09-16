/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	theme: {
		extend: {
			colors: {
				synapse: {
					bg: "#0b0f19",
					card: "#131b2e",
					border: "#1f293d",
					accent: "#00f0ff",
					purple: "#7000ff",
				},
			},
		},
	},
	plugins: [],
};
