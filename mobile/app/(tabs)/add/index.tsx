import { router } from "expo-router";
import { AddMenu } from "../../../src/ui/AddMenu";

export default function Add() {
  return <AddMenu onOpen={(href) => router.push(href as never)} />;
}
