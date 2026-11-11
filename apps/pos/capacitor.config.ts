import type { CapacitorConfig } from "@capacitor/cli";

/** The iPad app is the same PWA in a native shell: same screens, same sync engine, but storage in SQLite (not IndexedDB, which iOS may evict) and room for native device plugins. */
const config: CapacitorConfig = {
  appId: "app.shelfline.pos", appName: "Shelfline POS", webDir: "dist",
  ios: { contentInset: "never", scrollEnabled: false, limitsNavigationsToAppBoundDomains: false },
  server: { androidScheme: "https", iosScheme: "capacitor" },
  plugins: { CapacitorSQLite: { iosDatabaseLocation: "Library/CapacitorDatabase", iosIsEncryption: false } },
};
export default config;
