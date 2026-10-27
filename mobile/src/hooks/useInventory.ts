import { useQuery } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import {
  listColorStock,
  listFabricStock,
  listRollsOfColor,
  loadCountSheet,
  loadRollDetail,
} from "../core/inventory";
import { queryKeys } from "./queryKeys";

export function useFabricStock(q: string) {
  return useQuery({
    queryKey: queryKeys.fabricStock(q),
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? listFabricStock(app.phone, q) : [];
    },
  });
}

export function useColorStock(fabricId: string) {
  return useQuery({
    queryKey: queryKeys.colorStock(fabricId),
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? listColorStock(app.phone, fabricId) : [];
    },
  });
}

export function useColorRolls(colorId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.colorRolls(colorId),
    enabled,
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? listRollsOfColor(app.phone, colorId) : [];
    },
  });
}

export function useRollDetail(rollId: string) {
  return useQuery({
    queryKey: queryKeys.roll(rollId),
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? loadRollDetail(app.phone, rollId) : null;
    },
  });
}

export function useCountSheet(year: number, q: string) {
  return useQuery({
    queryKey: queryKeys.countSheet(year, q),
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? loadCountSheet(app.phone, year, q) : { lines: [], total: 0 };
    },
  });
}
