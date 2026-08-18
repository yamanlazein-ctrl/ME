import { createFileRoute } from "@tanstack/react-router";
import { PartyDetailsPage } from "@/components/parties/PartyDetails";

export const Route = createFileRoute("/suppliers/$id")({
  component: SupplierProfile,
});

function SupplierProfile() {
  const { id } = Route.useParams();
  return <PartyDetailsPage kind="supplier" id={id} />;
}
