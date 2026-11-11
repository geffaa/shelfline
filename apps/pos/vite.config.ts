import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Shelfline POS", short_name: "Shelfline", description: "Point of sale that keeps selling offline", start_url: "/", scope: "/", display: "standalone", orientation: "landscape",
        theme_color: "#14171C", background_color: "#ECEFF2",
        icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }, { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
      },
      // The whole shell (JS, CSS, fonts) is precached and versioned: the till opens with no network at all.
      workbox: { globPatterns: ["**/*.{js,css,html,svg,png,woff2,woff}"], navigateFallback: "/index.html", cleanupOutdatedCaches: true, clientsClaim: true, skipWaiting: true },
    }),
  ],
  build: { target: "es2022", sourcemap: false },
});
