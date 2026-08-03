import { importSubscriptionsResponse } from "@local/lib/subscription-route-handlers";

export async function POST(request: Request) {
  return importSubscriptionsResponse(request);
}
