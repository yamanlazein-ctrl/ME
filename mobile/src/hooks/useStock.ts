import { useQuery } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import {
  findLots,
  listCategories,
  listFabrics,
  loadColorLots,
  loadFabric,
  loadLot,
  type StockFilter,
} from "../core/stock";
import { queryKeys } from "./queryKeys";

async function phone() {
  const app = await getApp();
  if (!app.phone) throw new Error("الجهاز غير مسجّل");
  return app.phone;
}

export function useFabrics(q: string, filter: StockFilter, category: string | null) {
  return useQuery({
    queryKey: queryKeys.stockFabrics(q, filter, category),
    queryFn: async () => listFabrics(await phone(), q, filter, category),
    placeholderData: (previous) => previous,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: queryKeys.stockCategories,
    queryFn: async () => listCategories(await phone()),
  });
}

export function useLotSearch(q: string) {
  return useQuery({
    queryKey: queryKeys.stockLots(q),
    enabled: q.trim().length >= 2,
    queryFn: async () => findLots(await phone(), q),
  });
}

export function useFabric(id: string) {
  return useQuery({
    queryKey: queryKeys.stockFabric(id),
    queryFn: async () => loadFabric(await phone(), id),
  });
}

export function useColorLots(id: string) {
  return useQuery({
    queryKey: queryKeys.stockColor(id),
    queryFn: async () => loadColorLots(await phone(), id),
  });
}

export function useLot(id: string) {
  return useQuery({
    queryKey: queryKeys.stockLot(id),
    queryFn: async () => loadLot(await phone(), id),
  });
}
