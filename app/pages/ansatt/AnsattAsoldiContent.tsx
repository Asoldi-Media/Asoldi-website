import React from 'react';
import { CallTimesSection } from './CallTimesSection';
import {
  AboutUsSection,
  CalendarSection,
  InfoCards,
  LydklippSection,
  PartnersSection,
  ProductSections,
  StatsRow,
  WelcomeSection,
} from './shared';

const LYDKLIPP = [
  { file: 'lydklipp 1.wav', isNew: false },
  { file: 'lydklipp 2.wav', isNew: false },
  { file: 'lydklipp 3.wav', isNew: false },
  { file: 'lydklipp 4.wav', isNew: false },
  { file: 'domingo close call.wav', isNew: true },
  { file: 'sando close call.wav', isNew: true },
  { file: 'don fredo.wav', isNew: true },
  { file: 'rosa tattoo.wav', isNew: true },
  { file: 'smultringmannen donuthouse.wav', isNew: true },
  { file: 'Bjørkhov cafe og bar.wav', isNew: true },
  { file: 'zen art studio.wav', isNew: true },
] as const;

const STATS = [
  { value: '100', label: 'Laget nettsider til klienter' },
  { value: '300 000+', label: 'Håndterer månedlige besøkende til kunde nettsider' },
  { value: '10+', label: 'Content shoots for sosiale medier' },
  { value: '10+', label: 'År med markedsførings erfaring' },
] as const;

const PRODUCT_SECTIONS = [
  {
    title: 'Nettside tjenester',
    items: [
      {
        title: 'Nettside utvikling',
        body: 'Lager selve nettsiden med ønskede tjenester og tillegg, raskt, gunstig pris, og fantastisk kvalitet.',
      },
      {
        title: 'Nettside hosting',
        body: 'Holder nettsiden online, viktig for de med Ecommerce behov samt avlaster ansvaret for de bedriftene som har lyst på en mer “hands of” opplevelse',
      },
      {
        title: 'Opprettholdelse',
        body: 'Oppdateringer, bilde-oppdateringer, og andre lav investerende endringer i nettsiden inngår i dette. Hvis dette og hosting er noe kunden har lyst på.',
      },
      {
        title: 'Nettside migrasjon',
        body: 'Vi overfører en gammel eller ny nettside til en valgfri hosting tjeneste for kunden, samt kan skifte domene hvis ønskelig.',
      },
      {
        title: 'Nettside redesign',
        body: 'Har bedriften en nettside fra før av kan vi redesigne den med nye funksjoner i allerede eksisterende CMS (WordPress, Shopify, Wix etc).',
      },
      {
        title: 'Copywriting',
        body: 'Dette er teksten som står på nettsiden: optimalisert til å få kunden til å kjøpe, samt Google til å ranke – all tekst er intensjonell og forteller en historie.',
      },
    ],
  },
  {
    title: 'Nettside utviklings tjenester',
    items: [
      {
        title: 'SEO/google maps ranking',
        body: 'En av de største fordelene med å ha en nettside er å ranke høyt på Google/Google Maps. For de som vil ha mer organisk trafikk fra spesifikke søkeord som “restaurant i Trondheim”, “frisørsalong i Trondheim” etc.',
      },
      {
        title: 'Nettside analystikk',
        body: 'Lar bedriften se hvor lenge hver kunde er på nettsiden, view count og generell statistikk – viktig for de med høye besøkstall og generelt alle.',
      },
      {
        title: 'Email markedsføring',
        body: 'Funksjon som lar bedriften se og sende meldinger til folk sine e-poster og er høyt verdsatt av nettbutikker.',
      },
      {
        title: 'Ecommerce',
        body: 'Lar bedriften selge ting på nettsiden, og lar kundene lage kontoer (samle inn info). Passer bra med email marketing.',
      },
      {
        title: 'Multi-språklig',
        body: 'Lar nettsiden være på flere språk enn bare 1 – perfekt for bedrifter som har flerspråklige kunder og vil appellere til flere.',
      },
      {
        title: 'Blog integrering',
        body: 'Lar kunden skrive blogginnlegg som automatisk blir posted til nettsiden – øker SEO og Google Maps ranking, samt forsterker posisjon i markedet.',
      },
      {
        title: 'Booking og kontakt skjema',
        body: 'Lar kunden sende en melding eller bestille. Et billigere alternativ til ecommerce – for de som “bare vil ha en simpel nettside”.',
      },
      {
        title: 'Business info sync',
        body: 'Lar reviews, åpningstider, samt sosiale medier vises i sanntid i nettsiden. Øker konvertering og social proof.',
      },
    ],
  },
] as const;

export function AnsattAsoldiContent({
  identity = null,
}: {
  identity?: { name?: string; username?: string; fromEmail?: string } | null;
}) {
  return (
    <>
      <WelcomeSection title="Velkommen som telefonselger hos Asoldi" />

      <CallTimesSection identity={identity} />

      <CalendarSection />

      <AboutUsSection>
        <p>
          Vi er et 2 år gammelt nyoppstartet markedsføringsbyrå som tilbyr markedsføringsløsninger i form av
          webutvikling og sosiale medie markedsføring. Vi verdsetter kvalitet, fart og rimelig produksjon, salg og
          avsending av våre markedsføringsprodukter. Vi beveger oss fort og adapterer til trender og teknologier som AI
          automasjon og optimalisering. Dette gjør vi i form av å optimalisere tid det tar å gi produktet til våre
          kunder, prisene våre, samt effektivitet generelt i bedriften.
        </p>
        <p>
          Våre kjerneverdier inkluderer det å kunne gi muligheter til alle som har erfaring, ferdighet, eller
          lidenskap for alt innenfor markedsføring, utvikling og salg. Man trenger ikke nødvendigvis vite mye om ett
          felt innenfor markedsførings prosessene våre, så lenge man er villig til å lære, adaptere og utvikle seg. Vi
          streber også etter å gjøre det lettere for nyoppstartede bedrifter å navigere og ta nytte av markedet de har
          satt seg ut i, i form av våre tjenester.
        </p>
      </AboutUsSection>

      <InfoCards
        targetAudience={
          <>
            Vi selger primært til servicebedrifter uten nettside fra før. Disse trenger ofte bedre synlighet på Google
            og Google Maps, en enkel måte for kunder å booke tjenester, mulighet til å vise frem tjenestene sine på
            forhånd, og å bygge tillit før kjøp. Vi hjelper dem med å få flere kanaler for å nå ut til kundene sine.
          </>
        }
        goal={
          <>
            Som telefonselger booker du møter som salgsrepresentanten tar videre. Du samler inn nødvendig
            kundeinformasjon (de fem punktene i sjekklisten), og sørger for at kunden er interessert, engasjert og
            klar over hva møtet handler om før det avholdes.
          </>
        }
      />

      <LydklippSection clips={LYDKLIPP} />

      <ProductSections sections={PRODUCT_SECTIONS} />

      <StatsRow stats={STATS} />

      <PartnersSection>
        <div className="rounded-2xl bg-[#1a1a1a] border border-white/10 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Superhero burger og pizza</h3>
              <p className="text-gray-400 text-sm">Restaurant</p>
            </div>
            <img
              src="https://asoldi.com/wp-content/uploads/2025/12/logo.webp"
              alt="Superhero burger og pizza"
              className="h-12 w-auto opacity-90"
              loading="lazy"
            />
          </div>
          <div className="mt-5">
            <p className="text-white font-semibold mb-3">Resultater:</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <p className="text-white font-medium">Lagde en simpel nettside</p>
                <p className="text-gray-400 text-sm">SEO/maps ranking, synced SoMe posts</p>
              </div>
              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <p className="text-white font-medium">Analystikk</p>
                <p className="text-gray-400 text-sm">
                  Vi kan se over 10 000 nye månedlige besøkende og når de bouncer
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-[#1a1a1a] border border-white/10 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-white">S&apos;wich restaurant</h3>
              <p className="text-gray-400 text-sm">Restaurant</p>
            </div>
            <img
              src="https://asoldi.com/wp-content/uploads/2025/12/images.png"
              alt="S'wich restaurant"
              className="h-12 w-auto opacity-90"
              loading="lazy"
            />
          </div>
          <div className="mt-5">
            <p className="text-white font-semibold mb-3">Resultater:</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <p className="text-white font-medium">Lagde en simpel nettside</p>
                <p className="text-gray-400 text-sm">SEO/maps ranking, synced reviews/SoMe posts</p>
              </div>
              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <p className="text-white font-medium">Google maps ranking</p>
                <p className="text-gray-400 text-sm">
                  Gikk fra nr 10 til nr 6 på ranking for “restaurant” i Trondheim
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-[#1a1a1a] border border-white/10 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Svelstad gård</h3>
              <p className="text-gray-400 text-sm">Gård</p>
            </div>
            <img
              src="https://asoldi.com/wp-content/uploads/2025/12/Uten-navn-1000-x-500-px3.png"
              alt="Svelstad gård"
              className="h-16 w-auto rounded-lg opacity-90"
              loading="lazy"
            />
          </div>
          <div className="mt-5">
            <p className="text-white font-semibold mb-3">Resultater:</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <p className="text-white font-medium">Lagde en simpel nettside</p>
                <p className="text-gray-400 text-sm">Branded med 1 Kontakt skjema</p>
              </div>
              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <p className="text-white font-medium">Kontakt skjema</p>
                <p className="text-gray-400 text-sm">
                  10 nye bestillinger gjennom kontakt skjema, og 400 nye besøkende første uka
                </p>
              </div>
            </div>
          </div>
        </div>
      </PartnersSection>
    </>
  );
}
