# Client data gathering: onboarding and the AI assistant

Handoff for the developer. This is what the product owner wants, and what asoldi.com actually does today (3 Oct 2026). The code is the source of truth if this file drifts.

This is only the client’s own data gathering. It is not the sales card, the workshop need-list, or Website Maker’s pipeline.

## The point

Two steps, one store.

1. **Onboarding** (`/kunde/onboarding`) collects who the person is, which legal company they belong to, how to reach them, and optional public profiles. It is a short form. It does not build the product catalog or the media library.
2. **The AI assistant** (`/kunde/ai-assistant`) collects the heavy content and writes it into **Kundedata** (Innstillinger → Kundedata, `/kunde/innstillinger`). The client opens it from Hjem → «Steg 1: Sett opp nettsiden din».

The assistant is a data intake, not a brand interview. It asks for missing buckets, in a fixed order, and files each answer into the matching Kundedata field. It does not ask what kind of business they are, or whether the tone should be formal or casual.

**Do not ask for something we already have.** If a bucket is filled, or the client already said it is not relevant, skip it. Wording can vary a little so it does not feel like the same form every time. The order does not vary.

When the last missing bucket is done or skipped, tell them data gathering is finished and keep them on the assistant. The side panel shows each step with what is already saved. They can open bedriftsinformasjonen (`/kunde/innstillinger`) themselves when they want to edit.

## Where it is stored

Everything the assistant writes goes to `clientDataBank` on the portal profile. The client can review and edit the same fields under Kundedata. Tabs: Bedrifts kort, Produkter, Media, Ansatte, Generell info, Nettsidebygger v2-spørsmål. Settings also has Fakturering and Konto; those are not part of this intake.

Files live on disk at `~/.asoldi-website-data/client-uploads/<userId>/` and are served as `/client-media/...`.

## Onboarding

Six screens, one progress bar at the top. The source screen must not add a second bar.

| # | Screen | Wanted | Today |
|---|--------|--------|--------|
| 1 | «Hva heter du?» | Person’s name. | Saved on the profile. Also becomes the first Ansatte row (see below). |
| 2 | «Hva heter bedriften din?» | Search BRREG. After they pick a company, that pick is the answer. No second dropdown under the same choice, and the field must not stay a search they have to confirm again. | Picking a hit replaces the search with a green card (name, org.nr, address) and «Velg en annen bedrift». |
| 3 | «Hva er stillingen din?» | Job title. | Saved on the profile and on the signer employee row. |
| 4 | «Hvordan kan vi nå deg?» | Email required. Phone optional. | Email and phone go to Generell info (`companyEmail`, `companyPhone`). |
| 5 | «Gjør onboarding enda lettere!» | Optional profiles, framed as saving them time and giving a better first draft. Existing website, Instagram, Facebook, Google Business. No second progress bar. | Title is that sentence. Body copy says the links are used for images, prices, hours, and text, and that every field is optional. «Hopp over» if all four are empty. No inner progress bar. |
| 6 | «Hvordan fant du oss?» | Choices include «Over telefon», not «Telefon salg». | Options: Fra sosiale medier, Referanse, Over telefon, Annet. An old «Telefon salg» value is shown as «Over telefon». |

### Google Business on screen 5

The legal company name and the public Google name are often different. **Do not prefill** the Google search with the BRREG name.

The client searches the name as it appears on Google Maps and picks the real public profile. We need:

- the public profile name
- the Place ID
- the Google Maps URL

Today the search is server-side (`GET /api/client/places-search`, SerpAPI Google Maps, Norway). If a browser Maps key is set, the page can also use Places autocomplete. A chosen profile is shown as a card («Offentlig Google-profil er valgt. Place ID er lagret.»). The search box stays empty until they type. The earlier complaint was that a search for «Asoldi Media» returned the wrong businesses. The picker stores the right ids once a correct row is chosen; result quality still depends on that search.

### What onboarding writes

`PUT /api/client/profile` → `applyIntakeSourcesToBank` in `data/client-portal.js`.

| Answer | Where it lands |
|--------|----------------|
| Name, title, phone, email | Profile, plus the first Ansatte row, id `ansatt-signer`. Later team members are extra rows. The signer row does not count as «we already listed the team». |
| Company name, org.nr | Profile `businessName` / `businessOrgNumber`, and the bank company name and `brandIdentity.orgNumber` when those fields are still empty. |
| BRREG address shown on the card | **Not saved.** The form holds it and the save request does not send it. `generalInfo.companyAddress` stays empty. |
| Website, Instagram, Facebook | `generalInfo.websiteUrl`, `instagramUrl`, `facebookUrl`, plus `socialMediaLinks` and `websiteCreatorQuestions.relevantLinks`. |
| Google profile | `generalInfo.googlePlaceId`, `googlePlaceName`, `googleMapsUrl`, and `openingHours.googleBusinessSyncUrl`. |
| How they found us | Profile `discoveryChannel`. |

Onboarding stores the links. It does not scrape them. Finish goes to `/kunde/hjem`, not into the assistant.

## AI assistant

Route: `/kunde/ai-assistant`. Logic: `lib/ai-assistant/intake.js` and `lib/ai-assistant/service.js`. Chat: `POST /api/client/ai-assistant/chat`.

It looks at Kundedata and asks only the first empty bucket. The client can skip a bucket («nei», «ikke relevant», «hopp over»). A skip is stored on `clientDataBank.assistantIntake.<step>` as `skipped` or `done`, so the question does not come back.

### Order

| Step | Ask | If they say no | Where a yes is written | Today |
|------|-----|----------------|------------------------|--------|
| 1. Produkter | Products, services, or a menu. A site, a file, or a written list is enough. | Skip. | `productCatalogs` | After a save, ask if there is more. «Det er alt» or nei moves on. |
| 2. Media | Images or video they want on the site. | Skip. | Media library | Same follow-up as products. |
| 3. Logo | Logo image, only if one is not already there. | Skip. | `brandIdentity.logos.normal` and `media.logos` | One image, then the next step. No «more logos?» question. |
| 4. Ansatte | «Lyst til å vise informasjon om deres ansatte på siden?» Then title, name, phone, email, one person per line. | Skip. | `staff`, appended. Image is left empty. | After each person, ask if there are more. The signer from onboarding is ignored. |
| 5. Åpningstider | Monday–Sunday. Also accept «not relevant» or open 24/7. | «Not relevant» is a real answer, not a blank. | `openingHours.status` + `openingHours.days` | One answer, then the next step. Do not ask if every day was filled. |
| 6. Partnere | Partners or affiliations to show on the site. Group them if the client groups them («Sponsorer: …»). | Skip. | `affiliations` (category + items) | After a list, ask if there are more. |
| Done | Short line that gathering is finished. | — | Stay on the assistant. The panel is the profile card. A link opens `/kunde/innstillinger`. | Happens when every step above is filled or flagged. |

### Do not ask these in the assistant

Address, colours, org.nr, website language, city, county, phone, email, and the Nettsidebygger v2 questions. Onboarding or the settings page already owns them. This is a judgement, not a banned-word list: if the client volunteers one, keep it, but do not open a question for it.

Social links are the same idea. They are collected on onboarding screen 5. Do not add a social-links interview step when those fields are already filled.

### Products (the important step)

The client may mix sources in one go: a URL, several files, and typed text. Read them as one catalog, not as separate imports that ignore each other.

- Accept a website, Excel, PDF, text, or a list typed in the chat. Drag-and-drop is part of the upload.
- Do not ask them to pick «normal / meny / tiers». Choose the layout from the products and the source. Meny for a food menu, tiers when packages list what is included, otherwise normal.
- A new source can move products between categories. Do not only append a new category beside the old ones. Look at the site structure and the document headings and place items where those sources already group them. A sheet title or a diet label is not automatically its own shop category.
- Keep the rules general. A fix that only works for one cafe’s column layout, or one site’s «prices» page, is the wrong fix.
- Hard cap: **200 products**. Larger catalogs need a non-AI import. The assistant must say when it stopped at the cap.
- Text files and PDFs are documents, not images.
- While it works, the client must see that it is working (status line / thinking), and the side panel fills in as categories and counts appear.

Today: one ingest job reads files, URLs, and text together (`runUnifiedIngestJob`). Shopify and WooCommerce are detected and read through their public product feeds when those exist; other sites are read from the pages themselves (sitemap and offering pages). Layout is chosen from the content. A second import is merged into the catalogs already stored, then capped at 200. Saved products show under the Produkter step. The chat shows a status line while a job runs.

The side panel shows one layout at a time and slides to the next. Produkter lists the catalog in the grey placeholder style. Media switches to a picture grid. From the logo step on, the panel is a small profile card: a grey logo mark at the top left, then `Ansatte —` and a count, the opening hours written out, and up to three partner bars. It does not paste the real logo file into that mark.

Products, media, staff, and partners stay on that step after a save and ask if there is more. A no, or «det er alt», moves on. Opening hours and the logo are saved once and the assistant does not ask whether every day was filled.

The assistant does **not** start from the website URL saved in onboarding. The client has to send that link again in the chat. Instagram, Facebook, and the Google profile are also not used as product sources here.

### Media

For now, do not invent a category for every file. Put uploads in the media library.

Exception the product owner still wants: if the client says what a file is for («this first image should be the main image»), put that file in that bucket (Hovedbilde → `mainHeroImages`, and the same idea for Om oss, Ansatte, Lokasjon, and the other buckets). Text files never go in the media library.

Today every assistant media upload goes to `media.uncategorized` only. A sentence like «use this as the hero» is not read. Logo is the only image with its own slot, and only in the logo step.

## What is still not what he asked for

These are the gaps. The rest of the two flows above already matches the request.

1. **Product intake quality.** Sources must be read as one catalog, categories must follow the source’s own grouping, and a later file must be allowed to reshape that grouping. The machinery is there. The result is still the part he does not trust.
2. **Onboarding links are not reused.** Website, Instagram, Facebook, and Google profile are saved, then the assistant asks for a product source as if they were not.
3. **Media role.** Uploads always land in Annet. A stated role (hero and the other buckets) is ignored.
4. **BRREG address** is shown when they pick the company and then dropped on save.
5. **Google profile search** can still return the wrong businesses. The saved Place ID is only as good as the row they click.

## Files

- `app/pages/client/ClientOnboarding.tsx` — the six screens
- `data/client-portal.js` — `applyIntakeSourcesToBank`, signer employee, bank shape
- `lib/ai-assistant/intake.js` — order, skip, hours, staff, partners
- `lib/ai-assistant/service.js` — chat, media, logo, and the product job
- `lib/ai-assistant/products-ingest.js` and `products-scrape.js` — catalog reading
- `app/pages/client/ClientAiAssistant.tsx` — chat UI
- `app/pages/client/AssistantIntakePanel.tsx` — step panel for content already saved
- `app/pages/client/ClientSettings.tsx` — Kundedata, where the client checks the result
