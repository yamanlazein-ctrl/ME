import { router } from "expo-router";
import { ReportMenuView } from "../../../../src/ui/ReportViews";

export default function Reports() {
  return <ReportMenuView onOpen={(slug) => router.push(`/(tabs)/more/reports/${slug}` as never)} />;
}
