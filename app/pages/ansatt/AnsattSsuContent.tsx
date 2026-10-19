import React from 'react';
import {
  AboutUsSection,
  CalendarSection,
  InfoCards,
  LydklippSection,
  PartnersSection,
  ProductSections,
  StatsRow,
  WelcomeSection,
  partnerCardClass,
} from './shared';

const STATS = [
  { value: '7', label: 'Lokale skoler i programløp' },
  { value: '1 800', label: 'Ungdommer nådd siste 12 måneder' },
  { value: '420', label: 'Foresatte deltatt på foreldreforedrag' },
  { value: '35 000', label: 'Visninger på sosiale medier' },
  { value: '18', label: 'Arrangementer / skolebesøk gjennomført' },
] as const;

const PRODUCT_SECTIONS = [
  {
    title: 'Hva du får som SSU-partner',
    items: [
      {
        title: 'Partnerstatus',
        body: 'Bedriften kan bruke betegnelsen «SSU-partner» i egen kommunikasjon.',
      },
      {
        title: 'Lokal samfunnseffekt',
        body: 'Bidraget knyttes til ungdom og skoler i bedriftens nærområde.',
      },
      {
        title: 'Synlighet i sosiale medier',
        body: 'SSU publiserer innlegg der bedriften takkes som partner.',
      },
      {
        title: 'Arrangement-mentions',
        body: 'Bedriften kan nevnes i relevante arrangementer, skoleløp, foreldremøter eller lokale SSU-aktiviteter.',
      },
      {
        title: 'Enkel dokumentasjon',
        body: 'Bedriften får formuleringer, bilder/innhold og status som kan brukes i egne kanaler.',
      },
    ],
  },
] as const;

const SSU_SKOLER = [
  'Askim videregående skole',
  'Mysen videregående skole',
  'Ski videregående skole',
  'Romsdal videregående skole',
  'Orkdal videregående skole',
  'Malvik videregående skole',
] as const;

const SSU_SPONSORER = [
  'foraas.no',
  'Eidsberg Sparebank',
  'Askim & Spydeberg Sparebank',
  'Tinde Sparebank',
  'Istadkraft',
  'Orkla Sparebank',
  'Grue Sparebank',
  'SpareBank 1 Gudbrandsdal',
  'SpareBank 1 Sogn og Fjordane',
  'Sparebankstiftelsen Askim',
  'Hegra Sparebank',
] as const;

export function SsuIntroPanel() {
  return (
    <>
      <AboutUsSection>
        <p>
          Vi forebygger utenforskap, rus, ungdomskriminalitet, ensomhet og manglende tilhørighet gjennom foredrag,
          workshops, foreldrearbeid, kartlegging og oppfølging. SSU gir ungdom verktøy til å snakke om det vanskelige,
          be om hjelp tidligere og bygge tryggere klassemiljøer.
        </p>
        <p>
          SSU er et sponsorfinansiert program med foreldreforedrag, elevforedrag, workshops for ungdom, verktøy for
          lærere og ekstern måling av effekt. Målet er «selvstendige ungdommer som vet når de bør be om hjelp».
        </p>
        <p>
          Som partner får bedriften mer eksponering på SSU-kanaler og initiativer, samt status som SSU-partner med mange
          fordeler.
        </p>
          <p className="text-gray-900 font-medium">Nøkkelbudskap</p>
        <p>
          Når en bedrift blir SSU-partner, går bidraget direkte til at ungdom og skoler i bedriftens nærområde får
          tilgang til forebyggende arbeid som ellers ofte er vanskelig å finansiere.
        </p>
        <p>
          Programmet ledes av Arman Vestad og Fabiola Herfjord, med egne erfaringer fra utenforskap, livskriser og veien
          tilbake.
        </p>
        <p>
          Mange ungdommer opplever press, ensomhet, psykisk uhelse, økonomisk usikkerhet, rus, konflikter hjemme eller
          manglende tilhørighet. Når ungdom ikke tør å si fra, ikke har voksne de stoler på, eller ikke føler seg sett,
          kan små problemer utvikle seg til større utfordringer. SSU retter seg mot dette tidlig. Programmet er laget
          for VG1-elever og tar opp temaer som rusforebygging, utenforskap, inkludering, bygging av sterke relasjoner,
          vennlighet og økonomisk kunnskap.
        </p>
      </AboutUsSection>

      <InfoCards
        targetAudience={
          <>
            Vi selger til yrkesfaglige bedrifter og aktører med budsjett til å investere i samfunnsengasjement. De kjenner
            ofte utenforskap og frafall på nært hold, og er tilbøyelige til å investere i en organisasjon som SSU — som
            jobber konkret med akkurat dette.
          </>
        }
        goal={
          <>
            Som telefonselger booker du møter som salgsrepresentanten tar videre. Du samler inn nødvendig informasjon om
            bedriften (de fem punktene i sjekklisten), og sørger for at kontaktpersonen er interessert, engasjert og klar
            over hva partnerskapet innebærer før møtet avholdes.
          </>
        }
      />
    </>
  );
}

export function SsuLydklippPanel() {
  return <LydklippSection />;
}

export function AnsattSsuContent() {
  return (
    <>
      <WelcomeSection title="Velkommen som telefonselger for SSU" />

      <CalendarSection />

      <ProductSections sections={PRODUCT_SECTIONS} />

      <StatsRow stats={STATS} />
    </>
  );
}

export function SsuPartnersPanel() {
  return (
      <PartnersSection>
        <div className={partnerCardClass}>
          <p className="text-gray-700 text-sm leading-relaxed mb-4">
            SSU har vært gjennomført eller omtalt ved flere videregående skoler. I Follo og Indre Østfold startet
            Askim, Mysen og Ski videregående skoler programmet høsten 2024. Prosjektet ble finansiert av
            Sparebankstiftelsen Askim, Askim &amp; Spydeberg Sparebank og Eidsberg Sparebank.
          </p>
          <p className="text-gray-700 text-sm leading-relaxed">
            I Røros er programmet finansiert av RørosBanken og Haltdalen Sparebank, og omtales som et felles løft
            mellom elever, ansatte, foreldre og lokalsamfunnet.
          </p>
        </div>

        <div className={partnerCardClass}>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Noen skoler i programmet</h3>
          <div className="rounded-xl bg-white px-4 py-5">
            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
              {SSU_SKOLER.map((skole) => (
                <span key={skole} className="text-gray-900 text-sm font-medium text-center">
                  {skole}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className={partnerCardClass}>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Noen av våre sponsorer</h3>
          <div className="rounded-xl bg-white px-4 py-5">
            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
              {SSU_SPONSORER.map((sponsor) => (
                <span key={sponsor} className="text-gray-900 text-sm font-medium text-center">
                  {sponsor}
                </span>
              ))}
            </div>
          </div>
        </div>
      </PartnersSection>
  );
}
