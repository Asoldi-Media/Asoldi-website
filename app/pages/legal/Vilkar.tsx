import React from 'react';
import { Link } from 'react-router-dom';
import {
  LegalLayout,
  LegalSection,
  LegalSubheading,
  LegalList,
  LegalCallout,
} from '../../components/legal/LegalLayout';

const legalLinkClass = 'text-[#FF5B00] hover:underline';

export const Vilkar = () => {
  return (
    <LegalLayout
      title="Vilkår for bruk"
      description="Vilkårene for bruk av asoldi.com og for tjenestene Asoldi Markedsføring leverer. Ved å bruke nettstedet, opprette en konto eller inngå en tjenesteavtale med oss, aksepterer du disse vilkårene."
      path="/vilkar"
    >
      <LegalSection id="om-vilkarene" title="1. Om vilkårene">
        <p>
          Disse vilkårene gjelder for bruk av nettstedet asoldi.com, kundeportalen og alle tjenester levert av Asoldi
          Markedsføring (drevet under foretaket CHAPANA, org.nr. 934 327 497) («Asoldi», «vi», «oss»).
        </p>
        <p>
          Ved å bruke nettstedet, opprette en konto, velge en tjenestepakke eller på annen måte inngå et
          kundeforhold med oss, bekrefter du at du har lest og godtar disse vilkårene, vår{' '}
          <Link to="/personvern" className={legalLinkClass}>
            personvernerklæring
          </Link>{' '}
          og, når vi behandler personopplysninger på vegne av deg, vår{' '}
          <Link to="/databehandleravtale" className={legalLinkClass}>
            databehandleravtale
          </Link>
          . En signert tjenesteavtale (tilbudskontrakt) viser partene, valgt pakke og pris. Den viser til disse
          sidene i stedet for å gjenta hele katalogteksten. Ved motstrid mellom den signerte avtalens konkrete
          kommersielle vilkår (parter, pris, valgt omfang, forsinkelse, ansvarstak, eierskap og avslutning) og
          denne siden, går den signerte avtalen foran.
        </p>
      </LegalSection>

      <LegalSection id="bruk-av-nettstedet" title="2. Bruk av nettstedet og kontoen">
        <LegalList
          items={[
            'Du er ansvarlig for at opplysningene du oppgir er korrekte og oppdaterte.',
            'Du er ansvarlig for å holde innloggingsinformasjonen din konfidensiell og for all aktivitet på kontoen din.',
            'Du skal ikke misbruke nettstedet, forsøke å skaffe uautorisert tilgang, eller bruke tjenestene til ulovlige formål.',
            'Personen som inngår en avtale på vegne av en virksomhet bekrefter å ha fullmakt til å ta beslutninger for virksomheten. Uten slik fullmakt er avtalen ugyldig.',
          ]}
        />
      </LegalSection>

      <LegalSection id="tjenestekatalog" title="3. Tjenestekatalog">
        <p>
          Asoldi leverer nettside, hosting, vedlikehold og tilknyttede digitale tjenester som et løpende
          månedsabonnement. Nedenfor beskrives tjenestene, deretter hva som inngår i hvert nivå. Priser er
          oppgitt per måned ekskl. merverdiavgift med mindre noe annet er avtalt.
        </p>

        <LegalSubheading>Hva tjenestene betyr</LegalSubheading>
        <p>
          Nivåteksten nedenfor er en kort oversikt over hva som inngår. Forklaringene her sier hva
          tjenestenavnene betyr. Den signerte kontrakten har samme forklaringer på engelsk i punkt 5.
        </p>
        <LegalList
          items={[
            'Nettsidedesign og utvikling: Responsivt design (mobil, nettbrett og PC), utvikling og layout av de avtalte sidene. Siden er HTML-basert, har sitemap og settes opp mot kundens domene.',
            'Domenekobling: Kunden må kjøpe og eie sitt eget domene hvis de ikke allerede har ett. Asoldi selger ikke domenenavnet. Har kunden allerede et domene, kobler vi det til hostingen som inngår i månedsprisen. Koblingsarbeidet er inkludert; kunden betaler domeneregistratoren separat for selve navnet.',
            'Hosting og oppetid: Drift på Asoldis Hostinger-nettverk så lenge abonnementet er aktivt. Siden holdes tilgjengelig med kommersielt rimelig oppetid. Planlagt vedlikehold og feil hos tredjepart kan forekomme. Hosting inngår i månedsprisen.',
            'Vedlikehold og datalagring: Løpende drift slik at siden holder seg oppe — sikkerhet, sikkerhetskopier og teknisk stell. Vi tar datalagring på alvor og lagrer nettsidedata for å drifte, sikre og vedlikeholde tjenesten, se databehandleravtalen.',
            'Kontaktskjema og standard seksjoner: Kontaktskjema og vanlige bedriftsseksjoner for valgt omfang. Skjemaet lar besøkende sende melding og legge igjen e-post.',
            'Innholdsendringer: Inntil fire (4) mindre oppdateringer per måned, for eksempel priser, bilder eller tekst. Å legge til eller fjerne seksjoner, eller en større ombygging, avtales særskilt.',
            'Veiledningsmøte: Ett oppstartsmøte, én gang. På alle nivåer viser vi hvordan kunden bruker CMS. Når nettbutikk inngår, dekker samme møte også produkter, kunder og tilkobling av betalingsløsning. Etter det er enkle spørsmål tillatt; vi gir ikke løpende opplæring i å redigere siden.',
            'SEO (når det inngår): Løpende arbeid mot avtalte søkeord — tekst og teknisk struktur, sitemap, synlighet i Google Søk, Google Maps / Google Business Profile og AI-søk. Valgfrie steds- eller søkeordsrelaterte blogginnlegg inntil tre per uke når kunden ønsker det, og internlenkenettverket, når nivået inkluderer det. Ingen garanti for plassering, trafikk eller omsetning.',
            'Internlenkenettverk: Eksisterende Asoldi-kunder kan peke mot nye kunder, og nye mot andre i nettverket. Antall lenker varierer med kundebasen.',
            'Anmeldelser og synk mot sosiale medier (når det inngår): Krever at kunden logger inn på de aktuelle kontoene slik at vi kan koble synken. Vi lagrer ikke innloggingspassord til sosiale medier i kundens profil på asoldi.com. Kunden eier kontoene.',
            'Innsamling og lagring av e-postlister til markedsføring (når det inngår).',
            'Analyse og rapportering i kunde-CMS: Nivå 1 har verken analyseside eller rapportering. Nivå 2 får analyseside og en bi-ukentlig grunrapport (hver 14. dag). Nivå 3 får dypere innsikt og en ukentlig avansert rapport (hver 7. dag), inkludert nettbutikk-nøkkeltall når det inngår. Rapportene leveres i CMS, ikke som separat PDF med mindre det er avtalt skriftlig.',
            'Nettbutikk (når det inngår): Butikkoppsett, produktsider, utsjekk og kunderegistrering, inkludert nettbutikk-nøkkeltall som kjøp, konvertering og gjennomsnittlig ordreverdi.',
            'Flerspråklig nettside og butikk (nivå 3).',
            'Support i avtalt tid, se punkt 8.',
          ]}
        />
        <p>
          SEO gir ingen garanti for en bestemt plassering, et bestemt trafikkvolum eller et bestemt
          omsetningsresultat. Arbeidet er løpende.
        </p>

        <LegalSubheading>Nivå 1 – Standard (999 kr eks. mva per måned)</LegalSubheading>
        <LegalList
          items={[
            'Full utvikling av en enkel nettside uten nettbutikk, inntil fem (5) hovedsider, med responsivt design, utvikling og layout.',
            'HTML-basert side med sitemap.',
            'Kobling av kundens eget domene til inkludert hosting. Kunden kjøper domenet selv hvis de ikke har ett.',
            'Hosting og vedlikehold under aktivt abonnement.',
            'Kontaktskjema og seksjoner som kreves for en standard bedriftsnettside, unntatt nettbutikk og visning av anmeldelser.',
            'Opptil fire (4) mindre innholdsendringer per måned (for eksempel priser, bilder eller tekst). Ingen tillegg eller fjerning av seksjoner.',
            'Ett veiledningsmøte om CMS, holdt én gang.',
            'Inneholder ikke SEO-program, bloggskriving, internlenkenettverk, nettbutikk, analyseside i CMS eller rangerings- og resultatrapportering.',
            'Leveringstid: 2 uker fra prosjektstart.',
          ]}
        />

        <LegalSubheading>Nivå 2 – SEO (1 499 kr eks. mva per måned)</LegalSubheading>
        <p>Inkluderer alt i Nivå 1, utvidet til inntil syv (7) hovedsider, i tillegg til:</p>
        <LegalList
          items={[
            'Søkeordsoptimalisert tekst på siden.',
            'SEO for 1–3 avtalte søkeord, inkludert arbeid mot rangering i Google Søk, Google Maps (Google Business Profile) og AI-søk.',
            'Stedstilpassede, søkeordsrelaterte blogginnlegg inntil tre (3) per uke når kunden ønsker det.',
            'Deltakelse i Asoldis internlenkenettverk. Antall lenker varierer med kundebasen.',
            'Visning av anmeldelser og synk mot sosiale medier. Kunden logger inn for å koble kontoene; Asoldi lagrer ikke disse passordene i kundens asoldi.com-profil.',
            'Innsamling og lagring av e-postlister. Veiledningsmøtet dekker også hvor listene finnes og hvordan de brukes.',
            'Analyseside i CMS med kundens egne søkeordsrangeringer, trafikk, avvisningsrate, konvertering og Google Business Profile-utvikling.',
            'Bi-ukentlig grunrapport (hver 14. dag) i analysesiden: rangering og et sammendrag av perioden. En separat PDF inngår ikke med mindre det er avtalt skriftlig.',
            'Leveringstid: 2 uker fra prosjektstart.',
          ]}
        />

        <LegalSubheading>Nivå 3 – Nettbutikk (1 999 kr eks. mva per måned)</LegalSubheading>
        <p>Inkluderer alt i Nivå 2, utvidet til inntil ti (10) hovedsider, i tillegg til:</p>
        <LegalList
          items={[
            'Nettbutikkfunksjonalitet: butikkoppsett, produktsider, utsjekk og kunderegistrering.',
            'Flerspråklig nettside og butikk.',
            'Ukentlig avansert rapport (hver 7. dag) i analysesiden: rangering, dypere sammendrag enn nivå 2, og nettbutikk-nøkkeltall (kjøp, konverteringsrate, gjennomsnittlig ordreverdi).',
            'Veiledningsmøtet dekker også nettbutikk: legge inn produkter, legge til kunder og koble til betalingsløsning, pluss analysesiden.',
            'Leveringstid: 3 uker fra prosjektstart.',
          ]}
        />

        <LegalSubheading>Skreddersydd</LegalSubheading>
        <p>
          Omfang, pris og leveringstid avtales særskilt. Tjenestene ovenfor kan inngå helt eller delvis. Den
          signerte tilbudskontrakten fastsetter det konkrete omfanget.
        </p>
      </LegalSection>

      <LegalSection id="betaling" title="4. Betalingsvilkår">
        <LegalList
          items={[
            'Månedlige betalinger skjer den 1. i hver måned.',
            'Første måned faktureres forholdsmessig: månedspris ÷ antall dager i måneden × antall gjenværende dager etter levering.',
            'Faktura for første måned forfaller innen 7 dager etter levering av produktet. Påfølgende fakturaer forfaller innen 7 dager etter utstedelse.',
            'Godkjente betalingsmetoder: bankoverføring og Stripe.',
            'Det er ingen etableringsavgift for å starte abonnementet.',
            'Ved forsinket betaling påløper forsinkelsesrente og gebyrer etter gjeldende norsk lov. Ved fortsatt manglende betaling kan tjenesten suspenderes og avtalen sies opp, se punkt 13.',
          ]}
        />
      </LegalSection>

      <LegalSection id="bindingstid" title="5. Avtaleperiode og oppsigelse">
        <LegalList
          items={[
            'Minste bindingstid er 6 måneder.',
            'Oppsigelse krever 15 dagers varsel, og kunden betaler for hele oppsigelsesmåneden.',
            'Kunden kan ikke nedgradere til et lavere nivå etter at funksjonalitet fra et høyere nivå er lagt til.',
            'Kunden eier varig innholdet på nettsiden, designet og eventuell kode utviklet spesifikt for kunden. Eierskapet går ikke automatisk tilbake til Asoldi etter oppsigelse eller etter en frist.',
            'Innen syv (7) virkedager etter at abonnementet er avsluttet, gir Asoldi kunden tilgang til nettsidefilene slik siden står ved opphør (et øyeblikksbilde av den levende siden).',
            'Dersom kunden ønsker at Asoldi skal sette opp siden hos en ny vert eller på et nytt domene, kan kunden engasjere oss til det. Arbeidet faktureres etter gebyret for hosting-oppsett / overføring som til enhver tid er oppgitt på asoldi.com. Beløpet skrives ikke inn her fordi det kan endres.',
            'Dersom kunden forlater Asoldis Hostinger-nettverk, beholder kunden den eksporterte nettsiden slik den er ved opphør, men mister løpende abonnementstjenester: kontinuerlige nettsideoppdateringer, internlenkenettverket, nye CMS-oppdateringer, stedstilpasset bloggskriving for SEO, øvrig SEO-arbeid, support og andre løpende tjenester beskrevet i disse vilkårene.',
          ]}
        />
      </LegalSection>

      <LegalSection id="arbeidsomfang" title="6. Arbeidsomfang">
        <p>
          Asoldi leverer tjenestene som inngår i valgt nivå, med den betydningen som er beskrevet i punkt 3.
          Tjenester som ikke står i valgt nivå eller i den signerte kontraktens punkt 1, inngår ikke.
        </p>
        <LegalList
          items={[
            'Profesjonelt nettsidedesign og utvikling i henhold til valgt tjenestenivå.',
            'Domenekobling, hosting og vedlikehold på Asoldis Hostinger-nettverk under aktivt abonnement.',
            'Rimelige månedlige innholdsendringer, opptil fire per måned.',
            'Ett veiledningsmøte som beskrevet i punkt 3. Ingen løpende opplæring i redigering; enkle spørsmål er tillatt som del av administrasjonen.',
            'SEO-, blogg- og analysetjenester når det inngår i valgt nivå, inkludert rapportering med den frekvensen og kvaliteten som hører til nivået.',
          ]}
        />
        <p>
          En revisjon omfatter: tekstendringer, tillegg av en seksjon eller tillegg av funksjonalitet. Retting av
          skrivefeil eller faktiske feil regnes ikke som en revisjon. Redesign eller arbeid utenfor avtalt pakke
          medfører ekstra kostnader som avtales mellom partene.
        </p>
      </LegalSection>

      <LegalSection id="garanti" title="7. Leveringsgaranti, hosting og eierskap">
        <LegalSubheading>Leveringsgaranti</LegalSubheading>
        <p>
          Dersom Asoldi ikke leverer nettsiden innen tidsrammen for valgt pakke (2 eller 3 uker), får kunden én (1)
          måned med tjeneste gratis.
        </p>

        <LegalSubheading>Hostingfeil</LegalSubheading>
        <p>
          Dersom Asoldi over lengre tid blir ute av stand til å hoste nettsiden, mottar kunden en full eksport av
          nettsidefilene og innholdet kostnadsfritt. Full migrering til nytt domene eller ny hostingleverandør er
          valgfritt og følger i så fall gebyret for hosting-oppsett som er oppgitt på asoldi.com.
        </p>

        <LegalSubheading>Immaterielle rettigheter og eierskap</LegalSubheading>
        <LegalList
          items={[
            'I abonnementsperioden har kunden full rett til å bruke nettsiden.',
            'Kunden eier varig nettsidens innhold (inklusive data kunden selv styrer), designet og eventuell kode utviklet spesifikt for kunden. Dette eierskapet går ikke tilbake til Asoldi.',
            'Asoldi eier hostingmiljøet, verktøy for DNS-administrasjon, Asoldi CMS-programvaren, felles plattformkomponenter og tredjepartslisenser. Oppsigelse overfører ikke disse plattformressursene.',
            'Etter oppsigelse leverer Asoldi nettsidefilene innen syv (7) virkedager, se punkt 5.',
          ]}
        />
      </LegalSection>

      <LegalSection id="support" title="8. Support og vedlikehold">
        <LegalList
          items={[
            'Supporttider: 09:00–16:00 CET.',
            'Responstid for standardforespørsler: 1–3 dager.',
            'Responstid for hastesaker: innen 1 dag.',
          ]}
        />
      </LegalSection>

      <LegalSection id="kundens-ansvar" title="9. Kundens ansvar">
        <p>Kunden skal levere materialet som kreves for nettsiden, herunder:</p>
        <LegalList items={['Logo(er).', 'Bilder og/eller videoer.', 'Annet ønsket materiale som er nødvendig for nettsiden.']} />
      </LegalSection>

      <LegalSection id="gdpr" title="10. GDPR og databehandling">
        <LegalList
          items={[
            'Kunden er behandlingsansvarlig for personopplysninger som samles inn via kundens nettside (skjemaer, nettbutikk, e-postlister og lignende).',
            'Asoldi er databehandler for slike opplysninger og behandler dem for å hoste, vedlikeholde, sikre og drifte tjenesten.',
            'Kunden er ansvarlig for GDPR-etterlevelse overfor sine egne sluttkunder, inkludert personvernerklæring på egen nettside.',
          ]}
        />
        <p>
          Nærmere regler om lagringssted, underleverandører, sikkerhet, sletting og håndtering ved opphør står i{' '}
          <Link to="/databehandleravtale" className={legalLinkClass}>
            databehandleravtalen
          </Link>
          . Hvordan Asoldi behandler opplysninger om deg som vår kunde, står i{' '}
          <Link to="/personvern" className={legalLinkClass}>
            personvernerklæringen
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="ansvarsbegrensning" title="11. Ansvarsbegrensning">
        <p>Asoldi er ikke ansvarlig for:</p>
        <LegalList
          items={['indirekte, tilfeldige eller følgeskader,', 'tap av inntekter, virksomhet eller data.']}
        />
        <p>
          Asoldis samlede ansvar som følger av kundeforholdet er begrenset til abonnementsbeløpene kunden har
          betalt for de seks (6) månedene umiddelbart før kravet oppstod (ekskl. merverdiavgift), med mindre
          ufravikelig norsk lov gir kunden et mer omfattende krav. Tjenestene leveres «som de er», og vi gir
          ingen garanti for spesifikke kommersielle resultater.
        </p>
      </LegalSection>

      <LegalSection id="portefolje" title="12. Porteføljerettigheter">
        <p>
          Asoldi kan vise kundens nettside i porteføljer, annonser og markedsføringsmateriell, med mindre kunden
          reserverer seg mot dette ved skriftlig henvendelse.
        </p>
      </LegalSection>

      <LegalSection id="mislighold" title="13. Betalingsmislighold og suspensjon">
        <p>Dersom betaling ikke er mottatt innen 7 dager etter forfall, sendes en påminnelse til kunden.</p>
        <p>Dersom betaling ikke er mottatt innen 14 dager etter forfall:</p>
        <LegalList
          items={[
            'nettsiden kan suspenderes midlertidig (tas offline) frem til betaling er mottatt,',
            'det påløper forsinkelsesrente og gebyrer etter gjeldende norsk lov. Det brukes ikke en fast dagsmulkt på 100 kroner.',
          ]}
        />
        <p>Dersom betaling ikke er mottatt innen 30 dager:</p>
        <LegalList
          items={[
            'utestående beløp kan sendes til inkasso i samsvar med norsk lov,',
            'kunden forblir ansvarlig for alle ubetalte fakturaer.',
          ]}
        />
        <p>Asoldi forbeholder seg retten til å suspendere tjenester umiddelbart dersom svindelaktig betalingsaktivitet oppdages.</p>
      </LegalSection>

      <LegalSection id="lovvalg" title="14. Lovvalg og endringer">
        <p>
          Disse vilkårene er underlagt norsk lov. Eventuelle tvister søkes løst i minnelighet, og ellers ved norske
          domstoler.
        </p>
        <p>
          Vi kan oppdatere vilkårene ved behov. Vesentlige endringer varsles på nettstedet, og fortsatt bruk av
          tjenestene etter at endringer er publisert regnes som aksept av de oppdaterte vilkårene. For en allerede
          signert tilbudskontrakt gjelder de publiserte sidene slik de sto på signeringsdatoen, med mindre partene
          blir enige om noe annet.
        </p>
      </LegalSection>

      <LegalCallout title="Slik inngås avtalen">
        <p>
          Du aksepterer disse vilkårene når du tar i bruk nettstedet eller kundeportalen, velger en tjenestepakke
          eller bekrefter en bestilling. Når du mottar et tilbud, signerer du den konkrete tjenesteavtalen i
          kundeportalen. Det konkrete tjenestenivået, prisen og oppstartsdatoen fremgår av tilbudet. Hele
          tjenestekatalogen, personvernreglene og databehandleravtalen ligger på asoldi.com.
        </p>
      </LegalCallout>
    </LegalLayout>
  );
};
