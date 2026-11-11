import { notFound } from "next/navigation";
import { OrderStatus } from "@/components/OrderStatus";
import { orderView } from "@/lib/shop";

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = await params; const { t = "" } = await searchParams; const o = await orderView(id, t); if (!o) notFound();
  return <OrderStatus initial={o} token={t} />;
}
