"use client";
import { createContext, useContext } from "react";

/**
 * Which top-level product the signed-in person is currently in (AppShell's
 * post-login Factory / US Factory choice). Lets a page that both products
 * share -- e.g. RM Storage -- apply a Factory-only rule without forking
 * the page. Defaults to "us_factory" so any page rendered outside the
 * provider keeps its original, unchanged behavior.
 */
import type { Product } from "./currentProduct";
export type { Product };

const ProductContext = createContext<Product>("us_factory");

export const ProductProvider = ProductContext.Provider;

export function useProduct(): Product {
  return useContext(ProductContext);
}
