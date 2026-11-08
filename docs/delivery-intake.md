# What the client assistant asks

The assistant walks six steps for every client: products, media, logo, staff, opening hours and partners. It asks a further step only when the signed plan needs it and the answer is not already known.

- **Shop** (`ecom`): how goods are sent and what shipping costs, then return terms and the right of withdrawal. A legal name, organisation number and whether the business is VAT registered are asked only when both the number and the legal name are still unknown. Payment (Stripe or PayPal) is connected later in the website admin, so the assistant does not ask about it.
- **Search phrases** (`seo`): one to three phrases customers use, one per line or separated by commas. The town or area is asked only when the client's SEO scope needs one (`local`, `regional`, `niche-b2b`, empty or `unknown`) and none is known yet.
- **Booking** (`booking`, or a `booking` page in the page plan): the services customers should be able to book, one per line, with name, duration and price.

A plan without those services and without a booking page keeps the six steps.

## Ask only when it was left empty

| What | Read from, in order |
| --- | --- |
| Town or area | `clientDataBank.websiteCreatorQuestions.town`, then the portal profile's onboarding city or town, then the sales client's city |
| Organisation number | `clientDataBank.brandIdentity.orgNumber`, then `shopSetup.sellerVat.orgNumber`, then the sales client's organisation number |
| Legal name | `shopSetup.sellerVat.legalName`, then the sales client's legal name, then the offer's business name or party name |
| Search phrases | `websiteCreatorQuestions.importantKeywords`, or approved phrases already on the SEO record |
| Shipping and returns | `clientDataBank.shopSetup` |

A product list can be taken from the host of `generalInfo.websiteUrl` when the plan includes a shop and the bank has no products yet. The assistant does not fetch the site. The client answers yes, or uploads a list.

## The switch

`intake.tierSteps` in the automation settings. It is off by default.

- **Off.** The six steps. No new field is stored and replies do not carry the step list.
- **Shadow**, and **auto for a client who is not a pilot.** The extra steps are worked out and one delivery-audit row (`kind` `intake-steps`) is written for that client. The client still sees the six steps.
- **Auto.** Pilot clients are asked the extra steps.

## What is stored

`clientDataBank.shopSetup` is `{ shipping, returns, sellerVat: { legalName, orgNumber, vatRegistered }, bookingServices: [{ name, duration, price }] }`. The key is left out when all of those are empty, and a later save that does not send the key keeps the stored value. `assistantIntake` gains `shop`, `keywords` or `booking` only when the value is `done`, `skipped` or `more`.

Search phrases are appended to `websiteCreatorQuestions.importantKeywords` (at most ten) and written on the SEO record as `proposed` rows with source `client`. Nothing here approves a phrase. A phrase the SEO record refuses (a prescription-only substance) is not stored, and the reply says so. Phrases heard in a meeting are a different path: [seo-meeting-keywords.md](seo-meeting-keywords.md).

## The gate

The delivery gate's own lines still ask for anything the assistant did not collect. Skipping a shop, keyword or booking step does not decline those lines. Skipping logo, media, products, staff or hours still declines the lines it always did.
