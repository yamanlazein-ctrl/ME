import { createFileRoute } from "@tanstack/react-router";
import { PartyDetailsPage } from "@/components/parties/PartyDetails";

export const Route = createFileRoute("/customers/$id")({
  component: CustomerProfile,
});

function CustomerProfile() {
  const { id } = Route.useParams();
  return <PartyDetailsPage kind="customer" id={id} />;
}
