# Databehandleravtale: vedlegg om underleverandører og AI-behandling

Versjon dpa-1 (vilkårskatalog versjon 1, 2026-11-01).

Generert av `node scripts/legal-render.mjs --write` fra `lib/legal/hosts-register.json` og AI-reglene i
`packages/suite/harness/asoldi/llm.js`. Ikke rediger for hånd; `--check` feiler når filen er utdatert.

Vedlegget hører til databehandleravtalen versjon dpa-1. Det lister underleverandørene Asoldi bruker når Asoldi behandler personopplysninger på kundens vegne.

## Underleverandører

- Anthropic (Anthropic, PBC, USA, overføringsgrunnlag: EUs standardkontraktsvilkår): Språkmodeller (Claude) for tekst, analyse av materiale og oppsummering av møter. Opplysninger: navn, kontaktopplysninger, møtetranskripsjoner, e-postinnhold, bedriftsopplysninger.
- Brevo (Sendinblue SAS, EØS (Frankrike)): Sending av e-post: nyhetsbrev, kampanjer og automatiske e-poster fra kundenes nettsider, og e-post fra Asoldi. Opplysninger: navn, e-postadresse, meldingsinnhold, samtykke og avmelding.
- GitHub (GitHub, Inc., USA, overføringsgrunnlag: EUs standardkontraktsvilkår): Privat kodelager for kundenes nettsidefiler. Opplysninger: nettsidefiler med bedriftens kontaktopplysninger.
- Google (Google Ireland Limited og Google LLC, EØS og USA, overføringsgrunnlag: EUs standardkontraktsvilkår): Innlogging, kalender og Meet, Gmail-lesing for Asoldis egen innboks, bedriftsprofil, kart og steder, skrifttyper, Search Console og språkmodeller (Gemini). Opplysninger: bedriftsopplysninger, bilder kunden laster opp, kontrakter som PDF, navn, e-postadresse, møtetidspunkt, e-post til Asoldi, omtaler, bedriftsnavn, adresse, IP-adresse i nettleseren, innloggingsopplysninger.
- Hostinger (Hostinger International Ltd., EØS (Litauen)): Hosting av asoldi.com, kundenes nettsider og CMS-data, og e-postkontoene til Asoldi. Opplysninger: e-post til Asoldi, navn, e-postadresse, meldingsinnhold, domene, bedriftsnavn.
- PayPal (PayPal (Europe) S.à r.l. et Cie, S.C.A., EØS (Luxembourg)): PayPal-betaling i kundenes nettbutikker. Opplysninger: navn, e-postadresse, betalingsopplysninger.
- Resend (Resend, Inc., USA, overføringsgrunnlag: EUs standardkontraktsvilkår): Sending av transaksjons- og support-e-post. Opplysninger: navn, e-postadresse, meldingsinnhold.
- Stripe (Stripe Payments Europe, Ltd., EØS (Irland) og USA, overføringsgrunnlag: EUs standardkontraktsvilkår): Betaling av Asoldis abonnement og kortbetaling i kundenes nettbutikker. Opplysninger: navn, e-postadresse, betalingsopplysninger, IP-adresse i nettleseren.

## AI-behandling

- Anthropic: kan få personopplysninger og møtetranskripsjoner når oppgaven krever det.
- Google: kan få personopplysninger og møtetranskripsjoner når oppgaven krever det.
- DeepSeek: får bare offentlige opplysninger, opplysninger om bedriften eller anonymiserte data, aldri personopplysninger.
- OpenAI: brukes bare til automatisk kvalitetskontroll og får aldri personopplysninger.

## Leverandører som ikke får personopplysninger

- DataForSEO (DataForSEO, Utenfor Norge): Søkeordsdata og rangeringer i Google Søk og Google Maps. Får bare søkeord, bedriftsnavn og steder.
- DeepSeek (Hangzhou DeepSeek Artificial Intelligence Co., Ltd., Kina): Språkmodell for tekst på offentlige, syntetiske eller anonymiserte data. Får aldri personopplysninger eller møteopptak.
- SerpApi (SerpApi, LLC, USA): Søkeresultater for rangeringsmåling. Får bare søkeord og steder.
