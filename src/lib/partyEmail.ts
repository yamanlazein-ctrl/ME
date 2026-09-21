import { createPartySchema } from "@erp/shared";

export const INVALID_EMAIL_MESSAGE =
  "صيغة البريد الإلكتروني غير صحيحة — اكتب بريداً مثل name@example.com أو امسح الحقل (اختياري).";

/**
 * Party email is optional: blank is fine. A non-blank value must be a real
 * email — uses the exact rule the server enforces so client and server agree.
 * Returns an Arabic message, or null when the value is acceptable.
 */
export function partyEmailError(value: string | null | undefined): string | null {
  if (!value || value.trim() === "") return null;
  return createPartySchema.shape.email.safeParse(value).success ? null : INVALID_EMAIL_MESSAGE;
}

/**
 * Props that stop browsers from auto-filling saved usernames/emails/names into a
 * party email box (the source of "invalid email" errors the user never typed).
 */
export const PARTY_EMAIL_INPUT_PROPS = {
  type: "text" as const,
  inputMode: "email" as const,
  autoComplete: "off",
  name: "party-contact-email",
  dir: "ltr" as const,
  autoCapitalize: "off",
  spellCheck: false,
};
