import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/azeret-mono/400.css";
import "@fontsource/azeret-mono/500.css";
import "@fontsource/azeret-mono/600.css";
import "@shelfline/ui/styles.css";
import "./admin.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./state/auth";

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } } });
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={qc}><AuthProvider><App /></AuthProvider></QueryClientProvider></StrictMode>);
