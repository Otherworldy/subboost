import { exportSubscriptionsResponse } from "@local/lib/subscription-route-handlers";

export async function GET(request: Request) {
  return exportSubscriptionsResponse(request);
}
