# FIX-03 — icons, fonts, Hermes globals

- Tab icons were boxes because the tab screens had no `tabBarIcon` and no icon font was bundled. Now `@expo/vector-icons` Ionicons
  (home, people, add-circle, cube, menu), loaded with `expo-font` before the first screen (`src/ui/fonts.ts`); the root layout shows a
  visible error instead of the app if a font fails (`fonts-error`), and More shows `fonts-status` ("الخطوط والأيقونات: محمّلة", computed
  from `Font.isLoaded`). The emulator flow asserts that text and fails on the logcat line "is not a system font and has not been loaded".
- Hermes has no Node `Buffer`: the party detail and statement queries (keyset cursors, `base64url`) failed with
  `ReferenceError: Property 'Buffer' doesn't exist`. Found by the emulator run (logged as `MOTARD_ERR [query ["parties", id]]`).
  Fixed by `src/platform/bufferPolyfill.ts` (the `buffer` package + the missing `base64url` encoding), tested in
  `test/unit/bufferPolyfill.test.ts` against Node's own output.
- App lock bug found by the emulator: Android sends an "active" event right after a cold start, and the lock re-evaluation cleared a lock
  raised by the cold start whenever the last foreground moment was < 60 s old. Now only authentication lifts the lock. A fresh PIN sign-in
  does not ask again (`lockSignal.ts`); a cold start asks for the fingerprint automatically with the PIN field as the fallback.
