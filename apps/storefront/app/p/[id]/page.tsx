import Link from "next/link";
import { notFound } from "next/navigation";
import { Buy } from "@/components/Buy";
import { productPage } from "@/lib/shop";

export default async function Product({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const p = await productPage(id); if (!p) notFound();
  return (<>
    <nav aria-label="Breadcrumb" className="crumb"><Link href="/">All products</Link> / <span>{p.title}</span></nav>
    <div className="pdp">
      <div className="swatch big" aria-hidden>{p.title.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase()}</div>
      <div><span className="brand-line">{p.brand ?? " "}</span><h1>{p.title}</h1><Buy product={p} /></div>
    </div>
  </>);
}
