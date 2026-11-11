"use client";
import Link from "next/link";
import { useShop } from "./Cart";
export function CartLink() { const { count } = useShop(); return <Link href="/cart" className="cartlink" aria-label={`Basket, ${count} item${count === 1 ? "" : "s"}`} data-testid="cart-link">Basket<span className="cnt">{count}</span></Link>; }
