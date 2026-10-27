/** BC-4: the enrolment QR holds the JSON the phone's scanner parses: `{ "hub": <url>, "code": <code> }`. */
export function enrollmentQrPayload(hub: string, code: string): string {
  return JSON.stringify({ hub, code });
}
