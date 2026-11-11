import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/azeret-mono/400.css";
import "@fontsource/azeret-mono/500.css";
import "@fontsource/azeret-mono/600.css";
import "@shelfline/ui/styles.css";
import "./pos.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { openLocalStore, isNativeApp } from "./lib/store";
import { AppProvider } from "./state/app";

if (!isNativeApp()) registerSW({ immediate: true });         // the native app ships its own files; only the browser needs the service worker
void openLocalStore().then((store) => createRoot(document.getElementById("root")!).render(<StrictMode><AppProvider store={store}><App /></AppProvider></StrictMode>));
