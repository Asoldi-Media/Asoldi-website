# Checkout reminder consent on the Stripe session

`POST /api/hub/shop/stripe/checkout` stores what the shopper ticked on the session metadata:

- `reminder_consent` is `1` whenever the shop sends `reminderConsent: true`, with or without `customerEmail`. The shop may not know the address yet (Stripe collects it); the session read returns `customerEmail` and `reminderConsent` once the shopper has paid or the session expired. An unticked box is always `0`.
- `reminder_text_hash` is stored only together with a ticked box, when the shop sends `reminderTextHash` (letters, digits, `:`, `_`, `-`, at most 90 characters). It identifies the wording the shopper saw, so the consent can be shown later. It is absent when the shop sends none, so older shops get the same metadata as before apart from the ticked-without-address case.

The cms-spec `email` section accepts `identity.personalName` (sellers without an organisation number), `design` (brand tokens) and `signup` (double opt-in limits).
