import type { Metadata } from "next";
import Link from "next/link";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/azeret-mono/500.css";
import "./globals.css";
import { ShopProvider } from "@/components/Cart";
import { CartLink } from "@/components/CartLink";
import { front, shopConfig } from "@/lib/shop";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reserve online, collect in store", description: "See what is in stock at each store, reserve it, and pay when you collect." };

export default async function Layout({ children }: { children: React.ReactNode }) {
  const config = await shopConfig(); const f = await front();
  return (
    <html lang="en"><body>
      <ShopProvider config={config}>
        <a className="skip" href="#main">Skip to the products</a>
        <header className="bar"><div className="wrap bar-in"><Link href="/" className="brand"><span className="mk" aria-hidden>▁▃▅</span>{f?.name ?? "Shop"}</Link><span className="tag">Reserve online · collect &amp; pay in store</span><CartLink /></div></header>
        <main id="main" className="wrap">{children}</main>
        <footer className="wrap foot">Prices include GST. You pay when you collect. A reservation is held for 48 hours.</footer>
      </ShopProvider>
    </body></html>
  );
}
