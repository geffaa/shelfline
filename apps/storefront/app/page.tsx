import Link from "next/link";
import { catalog, front, money, type Card } from "@/lib/shop";

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string; c?: string }> }) {
  const { q = "", c = "" } = await searchParams; const [f, list] = await Promise.all([front(), catalog(q, c)]); const products = list?.products ?? [];
  return (<>
    <section className="hero"><h1>What is in stock near you</h1><p>Pick a store when you order. We hold it, you pay when you collect. {f && f.stores.length > 0 ? `Collect from ${f.stores.map((s) => s.name).join(", ")}.` : "No store is taking online pickups yet."}</p></section>
    <form className="search" role="search" action="/" method="get"><label className="sr" htmlFor="q">Search products</label><input id="q" name="q" defaultValue={q} placeholder="Search shoes, tees, socks" autoComplete="off" />{c ? <input type="hidden" name="c" value={c} /> : null}<button type="submit" className="btn">Search</button></form>
    {f && f.categories.length > 0 && <nav className="chips" aria-label="Categories"><Link href={q ? `/?q=${encodeURIComponent(q)}` : "/"} aria-current={!c ? "page" : undefined}>All</Link>{f.categories.map((x) => <Link key={x.id} href={`/?c=${x.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`} aria-current={c === x.id ? "page" : undefined}>{x.name}</Link>)}</nav>}
    {products.length === 0 ? <div className="empty"><h2>Nothing found</h2><p>{q ? `No products match “${q}”.` : "There are no products to show."}</p>{(q || c) && <Link href="/" className="btn">Clear the search</Link>}</div> :
      <ul className="grid" data-testid="products">{products.map((p) => <li key={p.id}><Tile p={p} currency={f?.currency} /></li>)}</ul>}
  </>);
}
function Tile({ p, currency }: { p: Card; currency?: string }) {
  const price = p.fromPriceMinor === p.toPriceMinor ? money(p.fromPriceMinor, currency) : `${money(p.fromPriceMinor, currency)} – ${money(p.toPriceMinor, currency)}`;
  return (
    <Link href={`/p/${p.id}`} className={`card${p.inStock ? "" : " out"}`} data-testid="product-card">
      <span className="swatch" aria-hidden>{p.title.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase()}</span>
      <span className="brand-line">{p.brand ?? " "}</span><span className="title">{p.title}</span><span className="price">{price}</span>
      <span className={`stock ${p.inStock ? "in" : "none"}`}>{p.inStock ? `${p.available > 9 ? "In stock" : `Only ${p.available} left`}` : "Out of stock"}</span>
    </Link>
  );
}
