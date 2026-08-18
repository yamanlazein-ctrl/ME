import { Outlet, createFileRoute } from "@tanstack/react-router";

// Layout route for /reports/*. The index (reports.index.tsx) and the report
// detail pages (reports.$slug.tsx) each render their own AppShell, so this
// layout is a pure pass-through that lets the $slug child actually render.
export const Route = createFileRoute("/reports")({
  component: ReportsLayout,
});

function ReportsLayout() {
  return <Outlet />;
}
