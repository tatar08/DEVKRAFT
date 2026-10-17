import { createFileRoute } from "@tanstack/react-router";
import { FounderCockpit } from "~/components/enterprise/FounderCockpit";

export const Route = createFileRoute("/_chat/work-orders")({ component: FounderCockpit });
