import { Checkout } from "@/components/Checkout";
import { front } from "@/lib/shop";
export default async function CartPage() { const f = await front(); return <Checkout stores={f?.stores ?? []} currency={f?.currency ?? "AUD"} />; }
